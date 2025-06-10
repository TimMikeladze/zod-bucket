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