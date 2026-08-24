/**
 * Manual, real-network smoke test for the LLM assessment layer.
 *
 * `npm run llm:check`
 *
 * This is the ONE place in the repo that is allowed to call Groq for real.
 * The Jest suite (tests/llm.test.js) never does — it injects a fake `fetch`
 * so CI is free, deterministic, and never depends on the network being up.
 * Run this by hand whenever you change GROQ_API_KEY, GROQ_MODEL_ID, or the
 * prompt, to confirm the wiring actually works end to end.
 */
import { createLlmService } from '../services/llm/index.js';
import { runAssessment, TIER } from '../services/triage/engine.js';
import env from '../config/env.js';

const CASES = [
  {
    label: 'Minor, everything normal — expect a LOW-leaning model tier',
    input: {
      vitals: { temperatureC: 37.0, spo2: 98, systolic: 118, diastolic: 76, pulseBpm: 74 },
      patient: { ageYears: 29, sex: 'female', registrationComplete: true },
      symptomText: 'small clean cut on the finger from kitchen work, bleeding stopped',
    },
  },
  {
    label: 'Chest pain, normal vitals — rule floor must land HIGH regardless',
    input: {
      vitals: { temperatureC: 36.9, spo2: 97, systolic: 122, diastolic: 80, pulseBpm: 88 },
      patient: { ageYears: 54, sex: 'male', registrationComplete: true },
      symptomText: 'crushing chest pain radiating to the left arm for the last hour',
    },
  },
];

async function main() {
  const service = createLlmService(env);

  if (!service) {
    console.error(
      '\nGROQ_API_KEY is not set in .env — nothing to test.\n' +
        'Copy the value into .env, then re-run: npm run llm:check\n',
    );
    process.exit(1);
  }

  console.log(`\nLLM smoke test — provider chain: ${service.providers.map((p) => p.name).join(' -> ')}\n`);

  let allOk = true;

  for (const testCase of CASES) {
    process.stdout.write(`${testCase.label} ... `);
    const startedAt = Date.now();

    try {
      const result = await runAssessment({ input: testCase.input, model: service });
      const ms = Date.now() - startedAt;

      console.log(`ok (${ms}ms)`);
      console.log(
        `  ruleTier=${result.ruleTier}  modelTier=${result.modelTier}  ` +
          `finalTier=${result.finalTier}  escalation=${result.escalationReason}`,
      );
      if (result.differential.length) {
        console.log(
          `  top differential: ${result.differential[0].condition} ` +
            `(${(result.differential[0].confidence * 100).toFixed(0)}%)`,
        );
      }

      if (result.finalTier === TIER.HIGH && result.ruleTier !== TIER.HIGH) {
        console.log('  note: HIGH came from the model, not the rule floor — worth a second look');
      }
    } catch (err) {
      allOk = false;
      console.log(`FAILED: ${err.message}`);
    }
    console.log('');
  }

  console.log(allOk ? 'All cases completed.' : 'One or more cases failed — see above.');
  process.exit(allOk ? 0 : 1);
}

main();
