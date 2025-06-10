import {
	DeleteObjectCommand,
	GetObjectCommand,
	ListObjectsV2Command,
	PutObjectCommand,
	S3Client,
} from "@aws-sdk/client-s3";
import { Rehiver } from "rehiver";
import type { ZodType, z } from "zod";

export type SchemaMap = Record<string, ZodType>;

// Enhanced config that supports both simple keys and partitioned paths
export interface ZodBucketConfig<
	T extends SchemaMap,
	P extends ZodType = ZodType,
> {
	bucket: string;
	prefix?: string;
	s3Client?: S3Client;
	schema: T;
	// Optional partition schema for path validation
	partitionSchema?: P;
	// Optional rehiver configuration
	rehiverOptions?: ConstructorParameters<typeof Rehiver>[0];
}

export type SchemaInfer<T extends SchemaMap> = {
	[K in keyof T]: z.infer<T[K]>;
};

// Type for partition-aware operations
export type PartitionedKey<P extends ZodType> = {
	key: string;
	partitions: z.infer<P>;
};

export class ZodBucket<T extends SchemaMap, P extends ZodType = ZodType> {
	private readonly bucket: string;
	private readonly prefix: string;
	private readonly s3Client: S3Client;
	private readonly schema: T;
	private readonly partitionSchema?: P;
	private readonly rehiver: Rehiver;
	private readonly partitionParser?: ReturnType<Rehiver["partitionParser"]>;

	constructor(config: ZodBucketConfig<T, P>) {
		this.bucket = config.bucket;
		this.prefix = config.prefix || "";
		this.s3Client = config.s3Client || new S3Client();
		this.schema = config.schema;
		this.partitionSchema = config.partitionSchema;

		// Initialize rehiver with custom options or defaults
		this.rehiver = new Rehiver({
			s3Options: {
				client: this.s3Client,
			},
			...config.rehiverOptions,
		});

		// Set up partition parser if partition schema is provided
		if (this.partitionSchema) {
			this.partitionParser = this.rehiver.partitionParser(this.partitionSchema);
		}
	}

	private getS3Key(key: string): string {
		return this.prefix ? `${this.prefix}/${key}` : key;
	}

	private extractKeyFromS3Key(s3Key: string): string {
		if (!this.prefix) {
			return s3Key;
		}
		return s3Key.startsWith(`${this.prefix}/`)
			? s3Key.slice(this.prefix.length + 1)
			: s3Key;
	}

	// Original simple key-based methods (unchanged for backward compatibility)
	async set<K extends keyof T>(key: K, value: z.infer<T[K]>): Promise<void> {
		const schemaForKey = this.schema[key];
		if (!schemaForKey) {
			throw new Error(`No schema defined for key: ${String(key)}`);
		}

		// Validate the value against the schema
		const validatedValue = schemaForKey.parse(value);

		const s3Key = this.getS3Key(String(key));

		const command = new PutObjectCommand({
			Bucket: this.bucket,
			Key: s3Key,
			Body: JSON.stringify(validatedValue),
			ContentType: "application/json",
		});

		await this.s3Client.send(command);
	}

	async get<K extends keyof T>(key: K): Promise<z.infer<T[K]> | null> {
		const schemaForKey = this.schema[key];
		if (!schemaForKey) {
			throw new Error(`No schema defined for key: ${String(key)}`);
		}

		const s3Key = this.getS3Key(String(key));

		try {
			const command = new GetObjectCommand({
				Bucket: this.bucket,
				Key: s3Key,
			});

			const response = await this.s3Client.send(command);

			if (!response.Body) {
				return null;
			}

			const bodyContent = await response.Body.transformToString();
			const rawValue = JSON.parse(bodyContent);

			// Validate the retrieved value against the schema
			return schemaForKey.parse(rawValue);
		} catch (error) {
			if (error instanceof Error && error.name === "NoSuchKey") {
				return null;
			}
			if (typeof error === "object" && error !== null && "$metadata" in error) {
				const awsError = error as { $metadata?: { httpStatusCode?: number } };
				if (awsError.$metadata?.httpStatusCode === 404) {
					return null;
				}
			}
			throw error;
		}
	}

	async delete<K extends keyof T>(key: K): Promise<boolean> {
		const s3Key = this.getS3Key(String(key));

		// First check if the object exists
		const exists = await this.exists(key);
		if (!exists) {
			return false;
		}

		try {
			const command = new DeleteObjectCommand({
				Bucket: this.bucket,
				Key: s3Key,
			});

			await this.s3Client.send(command);
			return true;
		} catch (error) {
			if (error instanceof Error && error.name === "NoSuchKey") {
				return false;
			}
			if (typeof error === "object" && error !== null && "$metadata" in error) {
				const awsError = error as { $metadata?: { httpStatusCode?: number } };
				if (awsError.$metadata?.httpStatusCode === 404) {
					return false;
				}
			}
			throw error;
		}
	}

	async list(): Promise<
		Array<{
			key: keyof T;
			lastModified?: Date;
			size?: number;
		}>
	> {
		const command = new ListObjectsV2Command({
			Bucket: this.bucket,
			Prefix: this.prefix || undefined,
		});

		const response = await this.s3Client.send(command);

		if (!response.Contents) {
			return [];
		}

		return response.Contents.filter((item) => item.Key !== undefined)
			.map((item) => {
				const extractedKey = this.extractKeyFromS3Key(item.Key || "");
				return {
					key: extractedKey as keyof T,
					lastModified: item.LastModified,
					size: item.Size,
				};
			})
			.filter((item) => item.key in this.schema); // Only return keys that exist in our schema
	}

	async exists<K extends keyof T>(key: K): Promise<boolean> {
		const result = await this.get(key);
		return result !== null;
	}

	// Get all values for keys that exist in S3
	async getAll(): Promise<Partial<SchemaInfer<T>>> {
		const keys = await this.list();
		const result: Partial<SchemaInfer<T>> = {};

		await Promise.all(
			keys.map(async ({ key }) => {
				const value = await this.get(key);
				if (value !== null) {
					(result as Record<string, unknown>)[key as string] = value;
				}
			}),
		);

		return result;
	}

	// NEW: Enhanced methods with partition support

	/**
	 * Set a value using a partitioned path
	 * @param path - The partitioned path (e.g., "year=2023/month=12/day=01")
	 * @param schemaKey - The schema key to validate against
	 * @param value - The value to store
	 */
	async setPartitioned<K extends keyof T>(
		path: string,
		schemaKey: K,
		value: z.infer<T[K]>,
	): Promise<void> {
		if (!(this.partitionParser && this.partitionSchema)) {
			throw new Error("Partition schema not configured");
		}

		// Validate the path against partition schema
		const partitions = this.partitionParser.parse(path);

		// Validate the value against the data schema
		const schemaForKey = this.schema[schemaKey];
		if (!schemaForKey) {
			throw new Error(`No schema defined for key: ${String(schemaKey)}`);
		}
		const validatedValue = schemaForKey.parse(value);

		// Construct the full S3 key
		const s3Key = this.getS3Key(`${path}/${String(schemaKey)}.json`);

		const command = new PutObjectCommand({
			Bucket: this.bucket,
			Key: s3Key,
			Body: JSON.stringify(validatedValue),
			ContentType: "application/json",
			Metadata: {
				// Store partition info in metadata for easier querying
				partitions: JSON.stringify(partitions),
				schemaKey: String(schemaKey),
			},
		});

		await this.s3Client.send(command);
	}

	/**
	 * Get a value using a partitioned path
	 */
	async getPartitioned<K extends keyof T>(
		path: string,
		schemaKey: K,
	): Promise<{ value: z.infer<T[K]>; partitions: z.infer<P> } | null> {
		if (!(this.partitionParser && this.partitionSchema)) {
			throw new Error("Partition schema not configured");
		}

		// Validate the path against partition schema
		const partitions = this.partitionParser.parse(path);

		const schemaForKey = this.schema[schemaKey];
		if (!schemaForKey) {
			throw new Error(`No schema defined for key: ${String(schemaKey)}`);
		}

		const s3Key = this.getS3Key(`${path}/${String(schemaKey)}.json`);

		try {
			const command = new GetObjectCommand({
				Bucket: this.bucket,
				Key: s3Key,
			});

			const response = await this.s3Client.send(command);

			if (!response.Body) {
				return null;
			}

			const bodyContent = await response.Body.transformToString();
			const rawValue = JSON.parse(bodyContent);

			// Validate the retrieved value against the schema
			const validatedValue = schemaForKey.parse(rawValue);

			return {
				value: validatedValue,
				partitions,
			};
		} catch (error) {
			if (error instanceof Error && error.name === "NoSuchKey") {
				return null;
			}
			if (typeof error === "object" && error !== null && "$metadata" in error) {
				const awsError = error as { $metadata?: { httpStatusCode?: number } };
				if (awsError.$metadata?.httpStatusCode === 404) {
					return null;
				}
			}
			throw error;
		}
	}

	/**
	 * Find objects matching partition patterns
	 * @param partialPartitions - Partial partition specification
	 * @param schemaKey - Optional schema key to filter by
	 */
	async findPartitioned<K extends keyof T>(
		partialPartitions: Partial<z.infer<P>>,
		schemaKey?: K,
	): Promise<Array<PartitionedKey<P> & { schemaKey: keyof T }>> {
		if (!(this.partitionParser && this.partitionSchema)) {
			throw new Error("Partition schema not configured");
		}

		// Create a glob pattern for the partial partitions
		const globPattern =
			this.partitionParser.createGlobPattern(partialPartitions);
		const searchPattern = schemaKey
			? `${globPattern}/${String(schemaKey)}.json`
			: `${globPattern}/*.json`;

		// Use rehiver to find matching objects
		const matchingObjects = await this.rehiver.findMatchingObjects({
			bucket: this.bucket,
			patterns: [this.getS3Key(searchPattern)],
		});

		const results: Array<PartitionedKey<P> & { schemaKey: keyof T }> = [];

		for (const objKey of matchingObjects) {
			try {
				// Extract the relative path from the S3 key
				const relativePath = this.extractKeyFromS3Key(objKey);

				// Parse the path to extract partitions and schema key
				const pathParts = relativePath.split("/");
				const fileName = pathParts.pop();
				const partitionPath = pathParts.join("/");
				const extractedSchemaKey = fileName?.replace(".json", "");

				if (!(extractedSchemaKey && extractedSchemaKey in this.schema)) {
					// Skip if not a valid schema key
					continue;
				}

				// Validate the partition path
				const partitions = this.partitionParser.parse(partitionPath);

				results.push({
					key: relativePath,
					partitions,
					schemaKey: extractedSchemaKey as keyof T,
				});
			} catch (error) {
				// Skip objects that don't match the partition schema
			}
		}

		return results;
	}

	/**
	 * Get the rehiver instance for advanced operations
	 */
	getRehiver(): Rehiver {
		return this.rehiver;
	}

	/**
	 * Get the partition parser for manual path operations
	 */
	getPartitionParser(): ReturnType<Rehiver["partitionParser"]> | undefined {
		return this.partitionParser;
	}

	/**
	 * Create a time partitioner using rehiver
	 */
	createTimePartitioner(options: Parameters<Rehiver["timePartitioner"]>[0]) {
		return this.rehiver.timePartitioner(options);
	}
}
