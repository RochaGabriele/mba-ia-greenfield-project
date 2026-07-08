import { registerAs } from '@nestjs/config';

export default registerAs('storage', () => ({
  // Internal endpoint used by the API and worker (Compose service name, per CLAUDE.md Docker rule).
  endpoint: process.env.STORAGE_ENDPOINT || 'http://minio:9000',
  // Endpoint that a browser/external client can reach (only used if presigned URLs are ever returned to clients).
  publicEndpoint:
    process.env.STORAGE_PUBLIC_ENDPOINT || 'http://localhost:9000',
  region: process.env.STORAGE_REGION || 'us-east-1',
  accessKey: process.env.STORAGE_ACCESS_KEY || 'streamtube',
  secretKey: process.env.STORAGE_SECRET_KEY || 'streamtube',
  bucket: process.env.STORAGE_BUCKET || 'streamtube-videos',
  uploadPartSizeMb: parseInt(process.env.UPLOAD_PART_SIZE_MB || '100', 10),
  maxUploadSizeGb: parseInt(process.env.MAX_UPLOAD_SIZE_GB || '10', 10),
  presignExpirationSeconds: parseInt(
    process.env.STORAGE_PRESIGN_EXPIRATION_SECONDS || '3600',
    10,
  ),
}));
