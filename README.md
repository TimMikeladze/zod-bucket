# 🪣 zod-bucket

Type-safe S3 object storage for TypeScript, powered by Zod.

zod-bucket provides a simple, type-safe API for interacting with S3-compatible object storage. Define your data structures with Zod schemas, and zod-bucket handles validation, serialization, and storage, ensuring that what you put in is what you get out. It also includes powerful support for partitioned data, making it easy to query and manage large datasets efficiently.

## Features

-   ✅ **Type-Safe:** Full TypeScript support with type inference from your Zod schemas.
-   🔒 **Schema Validation:** Data is automatically validated against your Zod schemas on read and write.
-   📦 **Simple API:** A clean and intuitive API for common S3 operations (`get`, `set`, `delete`, `list`, etc.).
-   🔌 **S3 Client Agnostic:** Bring your own S3 client - works with any S3-compatible storage provider.

## Installation

```console
npm install zod-bucket @aws-sdk/client-s3 
```

## Getting started

First, you need an S3 client from `@aws-sdk/client-s3`.

```typescript
import { S3Client } from "@aws-sdk/client-s3";

const s3Client = new S3Client({
	region: "us-east-1",
	// Add your credentials here
});
```

### 1. Define Your Schemas

Use Zod to define the schemas for the data you want to store.

```typescript
import { z } from "zod";

const UserSchema = z.object({
	id: z.string(),
	name: z.string(),
	email: z.string().email(),
});

const PostSchema = z.object({
	id: z.string(),
	title: z.string(),
	content: z.string(),
});

const mySchemas = {
	user: UserSchema,
	post: PostSchema,
};
```

### 2. Initialize ZodBucket

Create an instance of `ZodBucket` with your S3 client, bucket name, and schemas.

```typescript
import { ZodBucket } from "zod-bucket";

const bucket = new ZodBucket({
	s3Client,
	bucket: "my-app-bucket",
	schema: mySchemas,
});
```

## Usage

### Basic Operations

ZodBucket provides a simple key-value interface for storing and retrieving objects.

#### `set(key, value)`

Set a value for a given key. The value will be validated against the corresponding schema.

```typescript
await bucket.set("user", {
	id: "user-123",
	name: "John Doe",
	email: "john.doe@example.com",
});

// This will throw a ZodError if the data is invalid
await bucket.set("post", {
    id: "post-456",
    title: "My First Post"
    // Missing 'content' property
});
```

#### `get(key)`

Retrieve a value. It returns `null` if the key doesn't exist.

```typescript
const user = await bucket.get("user");
// user is typed as { id: string; name: string; email: string; } | null
if (user) {
	console.log(user.name); // "John Doe"
}
```

#### `delete(key)`

Delete an object by key.

```typescript
await bucket.delete("user");
```

#### `list()`

List all keys in the bucket (respecting the `keyPrefix`).

```typescript
const items = await bucket.list();
// [{ key: 'user', ... }, { key: 'post', ... }]
```

#### `getAll()`

Retrieve all objects from the bucket that match the defined schemas.

```typescript
const allData = await bucket.getAll();
// allData is typed as Partial<{ user: User; post: Post; }>
console.log(allData.user);
console.log(allData.post);
```

### Partitioned Data

For larger datasets, you can partition your data into a hierarchical path structure. This allows for more efficient querying by filtering on partition values.

#### 1. Add a Partition Schema

Define a schema for your partition keys.

```typescript
const PartitionSchema = z.object({
	year: z.string(),
	month: z.string(),
	day: z.string(),
});
```

#### 2. Initialize with `partitionSchema`

```typescript
const partitionedBucket = new ZodBucket({
	s3Client,
	bucket: "my-partitioned-bucket",
	schema: mySchemas,
	partitionSchema: PartitionSchema,
});
```

#### `setPartitioned(path, schemaKey, value)`

Store an object within a specific partition. The path is built from your partition keys.

```typescript
const path = "year=2023/month=12/day=25";

await partitionedBucket.setPartitioned(path, "user", {
	id: "user-456",
	name: "Jane Doe",
	email: "jane.doe@example.com",
});

await partitionedBucket.setPartitioned(path, "post", {
    id: "post-789",
    title: "A Partitioned Post",
    content: "This post is stored in a partition."
})
```
This stores the objects at `s3://my-partitioned-bucket/year=2023/month=12/day=25/user.json` and `s3://my-partitioned-bucket/year=2023/month=12/day=25/post.json`.

#### `getPartitioned(path, schemaKey)`

Retrieve a single object from a specific partition.

```typescript
const path = "year=2023/month=12/day=25";
const result = await partitionedBucket.getPartitioned(path, "user");

if (result) {
	console.log(result.value); // The user object
	console.log(result.partitions); // { year: '2023', month: '12', day: '25' }
}
```

#### `findPartitioned(partialPartitions, schemaKey?)`

Find all objects matching a partial partition specification. This is the most powerful feature of partitioning.

```typescript
// Find all objects from December 2023
const decemberData = await partitionedBucket.findPartitioned({
	year: "2023",
	month: "12",
});
// Returns an array of objects matching the partition.

// Find all 'user' objects from 2023
const users2023 = await partitionedBucket.findPartitioned(
	{ year: "2023" },
	"user",
);
// Returns an array of user objects from 2023.
```

## Mutex Support for Safe Writes

ZodBucket now includes built-in support for S3-based distributed locking using [s3-mutex](https://github.com/byndcloud/s3-mutex) to ensure safe concurrent writes. This is particularly useful when multiple services or instances need to write to the same S3 objects.

### Basic Usage with Mutex

```typescript
import { S3Client } from "@aws-sdk/client-s3";
import { ZodBucket } from "zod-bucket";
import { z } from "zod";

const s3Client = new S3Client({ region: "us-east-1" });

const schemas = {
  user: z.object({
    id: z.string(),
    name: z.string(),
    email: z.string().email(),
  }),
  settings: z.object({
    theme: z.enum(["light", "dark"]),
    notifications: z.boolean(),
  }),
};

// Mutex is enabled by default
const bucket = new ZodBucket({
  bucket: "my-data-bucket",
  s3Client,
  schema: schemas,
  // Optional: customize mutex behavior
  mutexOptions: {
    lockTimeoutMs: 60000,  // 1 minute timeout
    maxRetries: 5,         // Maximum retry attempts
    retryDelayMs: 200,     // Base delay between retries
  },
});

// All write operations are now mutex-protected
await bucket.set("user", { 
  id: "123", 
  name: "John Doe", 
  email: "john@example.com" 
});

// Safe concurrent writes - only one will succeed at a time
Promise.all([
  bucket.set("user", { id: "123", name: "John", email: "john@example.com" }),
  bucket.set("user", { id: "123", name: "Jane", email: "jane@example.com" }),
]);
```

### Disabling Mutex

If you don't need mutex protection, you can disable it:

```typescript
const bucketWithoutMutex = new ZodBucket({
  bucket: "my-data-bucket",
  s3Client,
  schema: schemas,
  enableMutex: false, // Disable mutex
});
```

### Advanced Mutex Operations

```typescript
// Check if mutex is enabled
if (bucket.isMutexEnabled()) {
  // Get direct access to the mutex instance for advanced operations
  const mutex = bucket.getMutex();
  
  // Manual lock acquisition (for custom operations)
  if (mutex) {
    const acquired = await mutex.acquireLock("custom-resource");
    if (acquired) {
      try {
        // Perform custom S3 operations
        // ...
      } finally {
        await mutex.releaseLock("custom-resource");
      }
    }
  }
}

// Clean up stale locks periodically
const cleanupResult = await bucket.cleanupStaleLocks({
  olderThan: Date.now() - 3600000, // Clean locks older than 1 hour
  dryRun: true, // Just report, don't actually delete
});

console.log(`Found ${cleanupResult.stale} stale locks out of ${cleanupResult.total}`);
```

### Partitioned Operations with Mutex

Mutex protection also works with partitioned operations:

```typescript
const partitionedBucket = new ZodBucket({
  bucket: "my-data-bucket",
  s3Client,
  schema: schemas,
  partitionSchema: z.object({
    year: z.string(),
    month: z.string(),
    day: z.string(),
  }),
  enableMutex: true, // Mutex enabled for partitioned writes too
});

// Safe partitioned writes
await partitionedBucket.setPartitioned(
  "year=2023/month=12/day=15",
  "user",
  { id: "123", name: "John Doe", email: "john@example.com" }
);
```

### Mutex Configuration Options

The `mutexOptions` parameter accepts the following options:

- `keyPrefix`: Prefix for lock keys (default: auto-generated based on bucket prefix)
- `maxRetries`: Maximum number of lock acquisition attempts (default: 5)
- `retryDelayMs`: Base delay between retries in milliseconds (default: 200)
- `maxRetryDelayMs`: Maximum delay between retries (default: 5000)
- `useJitter`: Add randomness to retry delays (default: true)
- `lockTimeoutMs`: Lock expiration time in milliseconds (default: 60000)
- `clockSkewToleranceMs`: Tolerance for clock differences (default: 1000)

### Performance Considerations

- S3-based locking has higher latency than in-memory solutions
- Consider using mutex only when necessary for data consistency
- Monitor lock contention in high-traffic scenarios
- Clean up stale locks periodically to maintain performance