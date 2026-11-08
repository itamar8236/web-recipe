// Runs an import in the background. A Workflow rather than a normal request because
// users paste a link and go back to YouTube, and a request stops when they leave.

import { WorkflowEntrypoint } from 'cloudflare:workers';
import { markFailed, runStage, STAGES } from './stages.js';

const RETRY = { retries: { limit: 2, delay: '15 seconds', backoff: 'exponential' }, timeout: '5 minutes' };

export class ImportWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const { importId, attempt } = event.payload;
    try {
      for (const stage of STAGES) {
        await step.do(stage.name, RETRY, () => runStage(this.env, importId, attempt, stage));
      }
    } catch {
      await step.do('mark failed', () => markFailed(this.env, importId, attempt));
    }
  }
}
