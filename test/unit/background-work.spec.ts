// A4: the queue request-otp hands its work to — answers first, sends later,
// one application's codes strictly in order.
import 'reflect-metadata';
import { BackgroundWork } from '../../src/common/background/background-work.service';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('BackgroundWork (A4)', () => {
  let work: BackgroundWork;

  beforeEach(() => {
    work = new BackgroundWork();
    jest.spyOn((work as any).logger, 'error').mockImplementation(() => undefined);
  });

  it('never runs a task in the caller’s own tick', async () => {
    let ran = false;
    work.run('t', async () => {
      ran = true;
    });
    expect(ran).toBe(false);
    await work.settled();
    expect(ran).toBe(true);
  });

  it('runs tasks with the same key in call order, even when the first is slower', async () => {
    const order: string[] = [];
    work.run('slow', async () => {
      await sleep(60);
      order.push('first');
    }, 'app-1');
    work.run('fast', async () => {
      order.push('second');
    }, 'app-1');
    await work.settled();
    expect(order).toEqual(['first', 'second']);
  });

  it('runs tasks with different keys independently', async () => {
    const order: string[] = [];
    work.run('slow', async () => {
      await sleep(60);
      order.push('slow');
    }, 'app-1');
    work.run('fast', async () => {
      order.push('fast');
    }, 'app-2');
    await work.settled();
    expect(order).toEqual(['fast', 'slow']);
  });

  it('settled() waits for tasks that a task starts', async () => {
    let nestedDone = false;
    work.run('outer', async () => {
      await sleep(10);
      work.run('inner', async () => {
        await sleep(30);
        nestedDone = true;
      }, 'k');
    });
    await work.settled();
    expect(nestedDone).toBe(true);
  });

  it('a failing task is logged and does not break the next one on the same key', async () => {
    const order: string[] = [];
    work.run('boom', async () => {
      throw new Error('boom');
    }, 'k');
    work.run('after', async () => {
      order.push('after');
    }, 'k');
    await work.settled();
    expect(order).toEqual(['after']);
    expect((work as any).logger.error).toHaveBeenCalledWith('boom failed', expect.stringContaining('boom'));
  });

  it('the shutdown hook waits for work in flight', async () => {
    let finished = false;
    work.run('send', async () => {
      await sleep(50);
      finished = true;
    });
    await work.beforeApplicationShutdown();
    expect(finished).toBe(true);
  });
});
