/**
 * Manual, real-network smoke test for wound image analysis.
 *
 * `npm run vision:check`
 *
 * The one place allowed to call Gemini for real. The Jest suite injects a
 * fake fetch, so CI is free, deterministic, and never spends quota.
 *
 * Renders three synthetic wounds of increasing severity and checks that the
 * rubric and the deterministic rule layer respond as intended — including
 * the property that matters most: a clean wound adds no escalation.
 */
import sharp from 'sharp';

import { analyseWound, toTriageText } from '../services/vision/woundAnalysis.js';
import { evaluateRules } from '../services/triage/rules.js';
import env from '../config/env.js';

const skin = '#c98f6a';

const CASES = [
  {
    label: 'Clean superficial cut',
    svg: `<rect width="640" height="480" fill="${skin}"/>
          <path d="M250 240 L390 250" stroke="#8f2418" stroke-width="7" fill="none"/>`,
  },
  {
    label: 'Wound with surrounding redness and discharge',
    svg: `<rect width="640" height="480" fill="${skin}"/>
          <ellipse cx="320" cy="240" rx="150" ry="105" fill="#c4553f" opacity="0.5"/>
          <ellipse cx="320" cy="240" rx="80" ry="52" fill="#9d2a1c"/>
          <ellipse cx="310" cy="234" rx="26" ry="17" fill="#d8cf9a"/>`,
  },
  {
    label: 'Deep wound with dark necrotic centre',
    svg: `<rect width="640" height="480" fill="${skin}"/>
          <ellipse cx="320" cy="240" rx="170" ry="120" fill="#b5432f" opacity="0.55"/>
          <ellipse cx="320" cy="240" rx="95" ry="66" fill="#6d1a12"/>
          <ellipse cx="320" cy="240" rx="48" ry="33" fill="#241012"/>`,
  },
];

async function render(svg) {
  return sharp(
    Buffer.from(`<svg width="640" height="480" xmlns="http://www.w3.org/2000/svg">${svg}</svg>`),
  ).png().toBuffer();
}

async function main() {
  if (!env.Gemini_API_Key && !env.GEMINI_API_KEY) {
    console.error('\nGemini_API_Key is not set in .env — nothing to test.\n');
    process.exit(1);
  }

  console.log('\nWound analysis smoke test — model: gemini-3.6-flash');
  console.log('Images are SYNTHETIC. This checks the pipeline, not clinical accuracy.\n');

  let ok = true;

  for (const testCase of CASES) {
    process.stdout.write(`${testCase.label}\n`);
    try {
      const image = await render(testCase.svg);
      const a = await analyseWound(image, 'image/png');

      const triageText = toTriageText(a);
      const rules = evaluateRules({
        vitals: { temperatureC: 37, spo2: 98, pulseBpm: 76 },
        patient: { ageYears: 34, registrationComplete: true },
        symptomText: `wound on the arm. ${triageText}`,
      });

      const signs = a.infectionSigns.filter((s) => s !== 'none_seen');
      console.log(`   visible=${a.isWoundVisible}  quality=${a.imageQuality}  depth=${a.depth}  ${a.latencyMs}ms`);
      console.log(`   tissue=${a.tissueAppearance.join(',') || '—'}  infection=${signs.join(',') || 'none seen'}`);
      console.log(`   triage phrase: ${triageText || '(none — adds no escalation)'}`);
      console.log(`   rule tier: ${rules.tier}  hits: ${rules.hits.map((h) => h.code).filter((c) => c.startsWith('wound_')).join(', ') || '(no wound rules fired)'}`);
      if (a.observations) console.log(`   observed: ${a.observations}`);
      console.log('');
    } catch (err) {
      ok = false;
      console.error(`   FAILED: ${err.message}\n`);
    }
  }

  console.log(
    ok
      ? 'All cases completed. Remember: synthetic images test the wiring, not clinical accuracy.\n'
      : 'One or more cases failed.\n',
  );
  process.exit(ok ? 0 : 1);
}

main();
