// Runs an import in the background. A Workflow rather than a normal request because
// users paste a link and go back to YouTube, and a request stops when they leave.

import { WorkflowEntrypoint } from 'cloudflare:workers';
import { markFailed, runStage, STAGES } from './stages.js';

const RETRY = { retries: { limit: 2, delay: '15 seconds', backoff: 'exponential' }, timeout: '15 minutes' };

// A busy Gemini (503) stays busy for minutes, past the quick retries above, so the stage
// is run again after a wait instead. Each wait is far below the 30 minutes after which a
// quiet import counts as stuck (imports.js).
const BUSY_WAIT = '5 minutes';
const BUSY_WAITS = 3;

export class ImportWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const { importId, attempt } = event.payload;
    try {
      for (const stage of STAGES) {
        for (let waits = 0; ; waits++) {
          const name = waits === 0 ? stage.name : `${stage.name} after wait ${waits}`;
          const result = await step.do(name, RETRY, () => runStage(this.env, importId, attempt, stage));
          if (!result?.busy) break;
          // The busy try already wrote llm_error to the row, for markFailed to keep.
          if (waits === BUSY_WAITS) throw new Error('model_busy');
          await step.sleep(`${stage.name} wait ${waits + 1}`, BUSY_WAIT);
        }
      }
    } catch {
      await step.do('mark failed', () => markFailed(this.env, importId, attempt));
    }
  }
}
