import { Test } from '@nestjs/testing';
import { WorkerModule } from './worker.module';

describe('WorkerModule', () => {
  it('compiles with the processor, metadata service, storage, DB and BullMQ wiring', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();

    expect(moduleRef).toBeDefined();

    await moduleRef.close();
  }, 30000);
});
