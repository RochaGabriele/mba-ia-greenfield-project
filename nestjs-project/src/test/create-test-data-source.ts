import { DataSource, EntitySchema, MigrationInterface } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import { Video } from '../videos/entities/video.entity';

interface TestDataSourceOptions {
  synchronize?: boolean;
  migrations?: (new () => MigrationInterface)[];
}

export function createTestDataSource(
  // TypeORM entity targets are classes; the bare Function type is intentional here.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  entities: (Function | string | EntitySchema<any>)[],
  options: TestDataSourceOptions = {},
): DataSource {
  const { synchronize = true, migrations } = options;
  // Channel declares a @OneToMany to Video (Phase 03), so TypeORM needs Video's metadata
  // whenever Channel is registered. Add it automatically so Phase 02 tests need not list it.
  const resolvedEntities =
    entities.includes(Channel) && !entities.includes(Video)
      ? [...entities, Video]
      : entities;
  return new DataSource({
    type: 'postgres',
    host: process.env.DB_HOST ?? 'db',
    port: Number(process.env.DB_PORT ?? 5432),
    username: process.env.DB_USERNAME ?? 'streamtube',
    password: process.env.DB_PASSWORD ?? 'streamtube',
    database: process.env.DB_DATABASE ?? 'streamtube',
    entities: resolvedEntities,
    synchronize,
    ...(migrations !== undefined && { migrations, migrationsRun: false }),
  });
}

export async function cleanAllTables(dataSource: DataSource): Promise<void> {
  // videos first — they FK-reference channels (Phase 03).
  await dataSource.query('DELETE FROM "videos"');
  await dataSource.query('DELETE FROM "refresh_tokens"');
  await dataSource.query('DELETE FROM "verification_tokens"');
  await dataSource.query('DELETE FROM "channels"');
  await dataSource.query('DELETE FROM "users"');
}
