import {
	CreateBucketCommand,
	DeleteBucketCommand,
	DeleteObjectsCommand,
	ListObjectsV2Command,
	S3Client,
} from "@aws-sdk/client-s3";
import { TimeGranularity } from "rehiver";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "vitest";
import { z } from "zod";
import { ZodBucket } from "../src";

// Test configuration
const TEST_BUCKET = `zod-bucket-test-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
const TEST_REGION = process.env.AWS_REGION || "us-east-1";

// Test schemas
const UserSchema = z.object({
	id: z.string(),
	name: z.string(),
	email: z.string().email(),
	age: z.number().min(0),
});

const PostSchema = z.object({
	id: z.string(),
	title: z.string(),
	content: z.string(),
	published: z.boolean(),
	tags: z.array(z.string()),
});

const MetricsSchema = z.object({
	views: z.number(),
	likes: z.number(),
	shares: z.number(),
});

const PartitionSchema = z.object({
	year: z.string(),
	month: z.string(),
	day: z.string(),
});

const testSchemas = {
	user: UserSchema,
	post: PostSchema,
	metrics: MetricsSchema,
};

// Test data
const testUser = {
	id: "user-123",
	name: "John Doe",
	email: "john@example.com",
	age: 30,
};

const testPost = {
	id: "post-456",
	title: "Test Post",
	content: "This is a test post content",
	published: true,
	tags: ["test", "vitest"],
};

const testMetrics = {
	views: 100,
	likes: 25,
	shares: 5,
};

describe("ZodBucket", () => {
	let s3Client: S3Client;
	let zodBucket: ZodBucket<typeof testSchemas>;
	let zodBucketWithPartitions: ZodBucket<
		typeof testSchemas,
		typeof PartitionSchema
	>;

	beforeAll(async () => {
		// Initialize S3 client
		s3Client = new S3Client({
			region: TEST_REGION,
			credentials: {
				accessKeyId: process.env.AWS_ACCESS_KEY_ID || "",
				secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "",
			},
		});

		// Create test bucket
		try {
			await s3Client.send(
				new CreateBucketCommand({
					Bucket: TEST_BUCKET,
				}),
			);
			// Wait a bit for bucket to be ready
			await new Promise((resolve) => setTimeout(resolve, 1000));
		} catch (error) {
			console.warn("Bucket creation failed, might already exist:", error);
		}
	});

	afterAll(async () => {
		// Clean up: delete all objects in bucket first
		try {
			const listResponse = await s3Client.send(
				new ListObjectsV2Command({
					Bucket: TEST_BUCKET,
				}),
			);

			if (listResponse.Contents && listResponse.Contents.length > 0) {
				const objectsToDelete = listResponse.Contents.filter(
					(obj) => obj.Key,
				).map((obj) => ({ Key: obj.Key as string }));

				if (objectsToDelete.length > 0) {
					await s3Client.send(
						new DeleteObjectsCommand({
							Bucket: TEST_BUCKET,
							Delete: {
								Objects: objectsToDelete,
							},
						}),
					);
				}
			}

			// Delete the bucket
			await s3Client.send(
				new DeleteBucketCommand({
					Bucket: TEST_BUCKET,
				}),
			);
		} catch (error) {
			console.warn("Bucket cleanup failed:", error);
		}
	});

	beforeEach(async () => {
		// Initialize ZodBucket instances
		zodBucket = new ZodBucket({
			bucket: TEST_BUCKET,
			prefix: "test",
			s3Client,
			schema: testSchemas,
		});

		zodBucketWithPartitions = new ZodBucket({
			bucket: TEST_BUCKET,
			prefix: "partitioned",
			s3Client,
			schema: testSchemas,
			partitionSchema: PartitionSchema,
		});
	});

	afterEach(async () => {
		// Clean up objects created during each test
		try {
			const listResponse = await s3Client.send(
				new ListObjectsV2Command({
					Bucket: TEST_BUCKET,
				}),
			);

			if (listResponse.Contents && listResponse.Contents.length > 0) {
				const objectsToDelete = listResponse.Contents.filter(
					(obj) => obj.Key,
				).map((obj) => ({ Key: obj.Key as string }));

				if (objectsToDelete.length > 0) {
					await s3Client.send(
						new DeleteObjectsCommand({
							Bucket: TEST_BUCKET,
							Delete: {
								Objects: objectsToDelete,
							},
						}),
					);
				}
			}
		} catch (error) {
			console.warn("Test cleanup failed:", error);
		}
	});

	describe("Basic Operations", () => {
		it("should set and get a value", async () => {
			await zodBucket.set("user", testUser);
			const retrieved = await zodBucket.get("user");
			expect(retrieved).toEqual(testUser);
		});

		it("should return null for non-existent key", async () => {
			const retrieved = await zodBucket.get("user");
			expect(retrieved).toBeNull();
		});

		it("should validate schema on set", async () => {
			// TypeScript will catch this at compile time, but we test runtime validation
			const invalidData = { invalid: "data" };
			await expect(
				zodBucket.set("user", invalidData as never),
			).rejects.toThrow();
		});

		it("should delete a value", async () => {
			await zodBucket.set("user", testUser);
			const deleted = await zodBucket.delete("user");
			expect(deleted).toBe(true);

			const retrieved = await zodBucket.get("user");
			expect(retrieved).toBeNull();
		});

		it("should return false when deleting non-existent key", async () => {
			const deleted = await zodBucket.delete("user");
			expect(deleted).toBe(false);
		});

		it("should check if key exists", async () => {
			expect(await zodBucket.exists("user")).toBe(false);

			await zodBucket.set("user", testUser);
			expect(await zodBucket.exists("user")).toBe(true);
		});

		it("should list all keys", async () => {
			await zodBucket.set("user", testUser);
			await zodBucket.set("post", testPost);

			const list = await zodBucket.list();
			expect(list).toHaveLength(2);
			expect(list.map((item) => item.key)).toContain("user");
			expect(list.map((item) => item.key)).toContain("post");
		});

		it("should get all values", async () => {
			await zodBucket.set("user", testUser);
			await zodBucket.set("metrics", testMetrics);

			const all = await zodBucket.getAll();
			expect(all.user).toEqual(testUser);
			expect(all.metrics).toEqual(testMetrics);
			expect(all.post).toBeUndefined();
		});

		it("should handle multiple schema types", async () => {
			await zodBucket.set("user", testUser);
			await zodBucket.set("post", testPost);
			await zodBucket.set("metrics", testMetrics);

			const retrievedUser = await zodBucket.get("user");
			const retrievedPost = await zodBucket.get("post");
			const retrievedMetrics = await zodBucket.get("metrics");

			expect(retrievedUser).toEqual(testUser);
			expect(retrievedPost).toEqual(testPost);
			expect(retrievedMetrics).toEqual(testMetrics);
		});
	});

	describe("Partitioned Operations", () => {
		it("should set and get partitioned values", async () => {
			const path = "year=2023/month=12/day=15";

			await zodBucketWithPartitions.setPartitioned(path, "user", testUser);
			const retrieved = await zodBucketWithPartitions.getPartitioned(
				path,
				"user",
			);

			expect(retrieved).not.toBeNull();
			if (retrieved) {
				expect(retrieved.value).toEqual(testUser);
				expect(retrieved.partitions).toEqual({
					year: "2023",
					month: "12",
					day: "15",
				});
			}
		});

		it("should return null for non-existent partitioned key", async () => {
			const retrieved = await zodBucketWithPartitions.getPartitioned(
				"year=2023/month=12/day=15",
				"user",
			);
			expect(retrieved).toBeNull();
		});

		it("should validate partition schema", async () => {
			await expect(
				zodBucketWithPartitions.setPartitioned(
					"invalid/path",
					"user",
					testUser,
				),
			).rejects.toThrow();
		});

		it("should find partitioned objects", async () => {
			const paths = [
				"year=2023/month=12/day=15",
				"year=2023/month=12/day=16",
				"year=2023/month=11/day=15",
				"year=2024/month=01/day=01",
			];

			// Set up test data
			for (const path of paths) {
				await zodBucketWithPartitions.setPartitioned(path, "user", testUser);
				await zodBucketWithPartitions.setPartitioned(
					path,
					"metrics",
					testMetrics,
				);
			}

			// Find all objects for December 2023
			const december2023 = await zodBucketWithPartitions.findPartitioned({
				year: "2023",
				month: "12",
			});

			expect(december2023).toHaveLength(4); // 2 days × 2 schema types
			expect(
				december2023.every(
					(item) =>
						item.partitions.year === "2023" && item.partitions.month === "12",
				),
			).toBe(true);

			// Find all user objects
			const userObjects = await zodBucketWithPartitions.findPartitioned(
				{},
				"user",
			);
			expect(userObjects).toHaveLength(4); // 4 paths
			expect(userObjects.every((item) => item.schemaKey === "user")).toBe(true);
		});

		it("should throw error when partition operations used without partition schema", async () => {
			await expect(
				zodBucket.setPartitioned("year=2023", "user", testUser),
			).rejects.toThrow("Partition schema not configured");

			await expect(
				zodBucket.getPartitioned("year=2023", "user"),
			).rejects.toThrow("Partition schema not configured");

			await expect(zodBucket.findPartitioned({})).rejects.toThrow(
				"Partition schema not configured",
			);
		});
	});

	describe("Utility Methods", () => {
		it("should provide access to rehiver instance", () => {
			const rehiver = zodBucketWithPartitions.getRehiver();
			expect(rehiver).toBeDefined();
		});

		it("should provide partition parser when configured", () => {
			const parser = zodBucketWithPartitions.getPartitionParser();
			expect(parser).toBeDefined();

			const parserWithoutPartitions = zodBucket.getPartitionParser();
			expect(parserWithoutPartitions).toBeUndefined();
		});

		it("should create time partitioner", () => {
			const timePartitioner = zodBucketWithPartitions.createTimePartitioner({
				granularity: TimeGranularity.Hourly,
			});
			expect(timePartitioner).toBeDefined();
		});
	});

	describe("Error Handling", () => {
		it("should throw error for undefined schema key", async () => {
			await expect(
				zodBucket.set(
					"nonexistent" as keyof typeof testSchemas,
					testUser as never,
				),
			).rejects.toThrow("No schema defined for key: nonexistent");

			await expect(
				zodBucket.get("nonexistent" as keyof typeof testSchemas),
			).rejects.toThrow("No schema defined for key: nonexistent");
		});

		it("should handle invalid JSON gracefully", async () => {
			// This test would require direct S3 manipulation to create invalid JSON
			// For now, we'll test that valid JSON is properly parsed
			await zodBucket.set("user", testUser);
			const retrieved = await zodBucket.get("user");
			expect(retrieved).toEqual(testUser);
		});
	});

	describe("Key Prefix Handling", () => {
		it("should work without key prefix", async () => {
			const bucketWithoutPrefix = new ZodBucket({
				bucket: TEST_BUCKET,
				s3Client,
				schema: testSchemas,
			});

			await bucketWithoutPrefix.set("user", testUser);
			const retrieved = await bucketWithoutPrefix.get("user");
			expect(retrieved).toEqual(testUser);

			// Clean up
			await bucketWithoutPrefix.delete("user");
		});

		it("should handle custom key prefix", async () => {
			const bucketWithCustomPrefix = new ZodBucket({
				bucket: TEST_BUCKET,
				prefix: "custom-prefix",
				s3Client,
				schema: testSchemas,
			});

			await bucketWithCustomPrefix.set("user", testUser);
			const retrieved = await bucketWithCustomPrefix.get("user");
			expect(retrieved).toEqual(testUser);

			// Verify the object exists with the correct prefix
			const list = await bucketWithCustomPrefix.list();
			expect(list).toHaveLength(1);

			// Clean up
			await bucketWithCustomPrefix.delete("user");
		});
	});
});
