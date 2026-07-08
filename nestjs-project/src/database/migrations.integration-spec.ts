import { DataSource } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import { createTestDataSource } from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video } from '../videos/entities/video.entity';
import { CreateUsersAndChannels1775687773260 } from './migrations/1775687773260-CreateUsersAndChannels';
import { CreateAuthTokens1777579850478 } from './migrations/1777579850478-CreateAuthTokens';
import { CreateVideos1783471470385 } from './migrations/1783471470385-CreateVideos';

const MANAGED_TABLES = [
  'users',
  'channels',
  'refresh_tokens',
  'verification_tokens',
  'videos',
];

const MANAGED_ENUMS = ['verification_tokens_type_enum', 'videos_status_enum'];

describe('Database migrations (integration)', () => {
  let dataSource: DataSource;

  async function enumExists(name: string): Promise<boolean> {
    const rows = await dataSource.query<{ typname: string }[]>(
      `SELECT typname FROM pg_type WHERE typname = $1`,
      [name],
    );
    return rows.length > 0;
  }

  beforeAll(async () => {
    dataSource = createTestDataSource(
      [User, Channel, RefreshToken, VerificationToken, Video],
      {
        synchronize: false,
        migrations: [
          CreateUsersAndChannels1775687773260,
          CreateAuthTokens1777579850478,
          CreateVideos1783471470385,
        ],
      },
    );

    await dataSource.initialize();

    // Drop sequentially (not concurrently) — the videos→channels FK makes concurrent CASCADE
    // drops prone to lock races on a shared, already-migrated database.
    for (const table of [...MANAGED_TABLES, 'migrations']) {
      await dataSource.query(`DROP TABLE IF EXISTS "${table}" CASCADE`);
    }
    // The enum types survive a DROP TABLE and may have been recreated by earlier
    // synchronize-based suites sharing this database; drop them so each migration's own
    // CREATE TYPE runs against a clean schema regardless of test-file order.
    for (const name of MANAGED_ENUMS) {
      await dataSource.query(`DROP TYPE IF EXISTS "${name}" CASCADE`);
    }
  });

  afterAll(async () => {
    // The second test undoes the last migration; re-apply everything so the shared DB is
    // fully migrated when subsequent suites run.
    await dataSource.runMigrations();
    await dataSource.destroy();
  });

  it('applies all migrations and creates the five tables (incl. videos) and status enum', async () => {
    const ranMigrations = await dataSource.runMigrations();

    expect(ranMigrations).toHaveLength(3);

    const result = await dataSource.query<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = ANY($1::text[])
       ORDER BY table_name`,
      [MANAGED_TABLES],
    );
    const tableNames = result.map((r) => r.table_name);
    expect(tableNames).toEqual([
      'channels',
      'refresh_tokens',
      'users',
      'verification_tokens',
      'videos',
    ]);

    expect(await enumExists('videos_status_enum')).toBe(true);
  });

  it('reverts the last migration and removes the videos table and its status enum', async () => {
    await dataSource.undoLastMigration();

    const result = await dataSource.query<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'videos'`,
    );
    expect(result).toHaveLength(0);
    expect(await enumExists('videos_status_enum')).toBe(false);
  });
});
