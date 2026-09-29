// The Room tests deliberately reconstruct the object against persistent storage
// and socket attachments. Actual WebSocket upgrades run in workerd in E2E tests.
export class DurableObject {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }
}
