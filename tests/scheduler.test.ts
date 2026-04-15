import { expect, test } from "bun:test";
import { NodeCronScheduler } from "../src/scheduler-node.js";

test("schedule registers a job and fires the handler", async () => {
  const s = new NodeCronScheduler();
  let fired = 0;
  const done = new Promise<void>((resolve) => {
    s.schedule("tick", "* * * * * *", async () => {
      fired++;
      resolve();
    });
  });
  expect(s.size()).toBe(1);
  await done;
  expect(fired).toBeGreaterThanOrEqual(1);
  s.cancelAll();
}, 5000);

test("cancel removes a single job", () => {
  const s = new NodeCronScheduler();
  s.schedule("a", "0 0 * * *", async () => {});
  s.schedule("b", "0 0 * * *", async () => {});
  expect(s.size()).toBe(2);
  s.cancel("a");
  expect(s.size()).toBe(1);
  s.cancelAll();
});

test("schedule with duplicate id replaces the prior job", () => {
  const s = new NodeCronScheduler();
  s.schedule("a", "0 0 * * *", async () => {});
  s.schedule("a", "0 1 * * *", async () => {});
  expect(s.size()).toBe(1);
  s.cancelAll();
});

test("cancelAll empties the registry", () => {
  const s = new NodeCronScheduler();
  s.schedule("a", "0 0 * * *", async () => {});
  s.schedule("b", "0 0 * * *", async () => {});
  s.cancelAll();
  expect(s.size()).toBe(0);
});

test("cancel on unknown id is a no-op", () => {
  const s = new NodeCronScheduler();
  s.cancel("missing");
  expect(s.size()).toBe(0);
});
