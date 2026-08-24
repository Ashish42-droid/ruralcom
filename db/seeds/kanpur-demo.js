/**
 * Kanpur demo seed data.
 *
 * ======================== THIS IS NOT REAL DATA ========================
 * Generated at the project owner's explicit request for the Kanpur demo.
 * Every row is written with `data_source = 'PLACEHOLDER_DEMO'`, which the
 * schema defaults to and the UI is expected to surface.
 *
 * What is real: the geography. Uttar Pradesh, Kanpur Nagar and its
 * neighbouring districts, and the block/tehsil names are public
 * administrative fact.
 *
 * What is NOT real, and deliberately so:
 *   - Every doctor is fictional. No name here belongs to a real
 *     practitioner, and every registration number is prefixed `DEMO-` so it
 *     cannot be mistaken for a real UP Medical Council number.
 *   - Every facility name is fictional or generic. Where a name resembles a
 *     real institution, that is a coincidence of naming convention
 *     (numbered PHCs, block names), not a reference to it.
 *   - EVERY phone number is +91-00000-0000X. Indian mobile numbers begin
 *     6-9, so a leading 0 cannot route to any real subscriber. Generating
 *     plausible-looking numbers would risk a demo dialling a stranger.
 *   - Coordinates are approximate district centroids, not surveyed
 *     facility locations. They are good enough to demonstrate
 *     nearest-hospital matching and nothing more.
 *
 * Before any real deployment this must be replaced with data from the ABDM
 * Health Facility Registry and the Healthcare Professionals Registry.
 * =======================================================================
 */

export const DATA_SOURCE = 'PLACEHOLDER_DEMO';

/** Unambiguously non-routable. See the note above. */
export const demoPhone = (n) => `+91-00000-${String(n).padStart(5, '0')}`;

export const STATE = {
  name: 'Uttar Pradesh',
  code: 'UP',
};

/**
 * Kanpur Nagar plus neighbours, so cross-district referral is
 * demonstrable rather than hypothetical.
 */
export const DISTRICTS = [
  { name: 'Kanpur Nagar', code: 'UP-KNP', lat: 26.4499, lng: 80.3319 },
  { name: 'Kanpur Dehat', code: 'UP-KND', lat: 26.4200, lng: 79.9900 },
  { name: 'Unnao', code: 'UP-UNN', lat: 26.5464, lng: 80.4879 },
];

/**
 * Facilities per district.
 *
 * The mix is deliberate and mirrors how rural care is actually tiered: a
 * few village health centres feeding a PHC, feeding a CHC, feeding one
 * district hospital. That shape is what makes the referral chain in the
 * demo look like real health administration rather than a flat list.
 */
export const FACILITIES = [
  // --- Kanpur Nagar ---
  { district: 'UP-KNP', name: 'Bilhaur Village Health Centre', type: 'village_health_centre', lat: 26.8450, lng: 80.0670, beds: 0 },
  { district: 'UP-KNP', name: 'Ghatampur Village Health Centre', type: 'village_health_centre', lat: 26.1450, lng: 80.1670, beds: 0 },
  { district: 'UP-KNP', name: 'Shivrajpur Village Health Centre', type: 'village_health_centre', lat: 26.7500, lng: 80.1000, beds: 0 },
  { district: 'UP-KNP', name: 'Bidhnu Primary Health Centre', type: 'phc', lat: 26.3600, lng: 80.2700, beds: 6 },
  { district: 'UP-KNP', name: 'Sarsaul Primary Health Centre', type: 'phc', lat: 26.4200, lng: 80.4800, beds: 6 },
  { district: 'UP-KNP', name: 'Bilhaur Community Health Centre', type: 'chc', lat: 26.8500, lng: 80.0700, beds: 30 },
  { district: 'UP-KNP', name: 'Kanpur Nagar District Hospital (Demo)', type: 'district_hospital', lat: 26.4499, lng: 80.3319, beds: 220 },

  // --- Kanpur Dehat ---
  { district: 'UP-KND', name: 'Akbarpur Village Health Centre', type: 'village_health_centre', lat: 26.4300, lng: 79.9800, beds: 0 },
  { district: 'UP-KND', name: 'Rasulabad Village Health Centre', type: 'village_health_centre', lat: 26.7500, lng: 79.9200, beds: 0 },
  { district: 'UP-KND', name: 'Derapur Primary Health Centre', type: 'phc', lat: 26.4100, lng: 79.8500, beds: 6 },
  { district: 'UP-KND', name: 'Kanpur Dehat District Hospital (Demo)', type: 'district_hospital', lat: 26.4200, lng: 79.9900, beds: 150 },

  // --- Unnao ---
  { district: 'UP-UNN', name: 'Hasanganj Village Health Centre', type: 'village_health_centre', lat: 26.8800, lng: 80.6300, beds: 0 },
  { district: 'UP-UNN', name: 'Purwa Primary Health Centre', type: 'phc', lat: 26.4700, lng: 80.7700, beds: 6 },
  { district: 'UP-UNN', name: 'Unnao District Hospital (Demo)', type: 'district_hospital', lat: 26.5464, lng: 80.4879, beds: 180 },
];

/**
 * Fictional doctor names, Indian-origin, spread across surnames common in
 * Uttar Pradesh so the roster reads plausibly for the audience without
 * naming anyone real.
 */
const GIVEN_NAMES = [
  'Aarti', 'Vikram', 'Sunita', 'Rajesh', 'Meena', 'Anil', 'Kavita', 'Deepak',
  'Nisha', 'Manoj', 'Pooja', 'Sanjay', 'Rekha', 'Ashok', 'Shalini', 'Ramesh',
  'Priya', 'Alok', 'Anjali', 'Vinod', 'Neha', 'Sandeep', 'Geeta', 'Mukesh',
  'Swati', 'Devendra', 'Kiran', 'Harish', 'Bhavna', 'Naveen',
];

const SURNAMES = [
  'Sharma', 'Verma', 'Gupta', 'Tiwari', 'Yadav', 'Mishra', 'Pandey', 'Dubey',
  'Srivastava', 'Awasthi', 'Katiyar', 'Nigam', 'Trivedi', 'Shukla', 'Dixit',
];

/**
 * Specialities matched to what a district-level roster actually needs, and
 * to the disease categories the triage engine can emit.
 */
const SPECIALITIES = [
  ['general_medicine'],
  ['general_medicine'],
  ['paediatrics'],
  ['obstetrics_gynaecology'],
  ['cardiology'],
  ['pulmonology'],
  ['orthopaedics'],
  ['dermatology'],
  ['general_surgery'],
  [], // a generalist — eligible for anything
];

/**
 * Builds a deterministic roster of N doctors per district.
 *
 * Deterministic on purpose: re-running the seed produces the same roster,
 * so a demo script that says "Dr Aarti Sharma will take this call" stays
 * true between runs.
 */
export function buildDoctors(perDistrict = 10) {
  const doctors = [];
  let n = 0;

  for (const district of DISTRICTS) {
    for (let i = 0; i < perDistrict; i += 1) {
      const given = GIVEN_NAMES[n % GIVEN_NAMES.length];
      const surname = SURNAMES[(n * 7 + i) % SURNAMES.length];
      n += 1;

      doctors.push({
        districtCode: district.code,
        fullName: `Dr ${given} ${surname}`,
        // DEMO- prefix so this can never be mistaken for a real council number.
        registrationNo: `DEMO-${district.code}-${String(i + 1).padStart(3, '0')}`,
        specialities: SPECIALITIES[i % SPECIALITIES.length],
        phone: demoPhone(n),
        // Two-thirds available, so load balancing has something to balance
        // and "no doctor available" is also reachable in a demo.
        availabilityStatus: i % 3 === 0 ? 'offline' : 'available',
        email: `demo.doctor.${district.code.toLowerCase()}.${i + 1}@ruralai-demo.invalid`,
      });
    }
  }

  return doctors;
}

/** One clinical assistant per village health centre. */
export function buildAssistants() {
  return FACILITIES.filter((f) => f.type === 'village_health_centre').map((f, i) => {
    const given = GIVEN_NAMES[(i * 3 + 5) % GIVEN_NAMES.length];
    const surname = SURNAMES[(i * 5 + 2) % SURNAMES.length];
    return {
      facilityName: f.name,
      fullName: `${given} ${surname}`,
      certificationRef: `DEMO-CHO-${String(i + 1).padStart(3, '0')}`,
      phone: demoPhone(500 + i),
      email: `demo.assistant.${i + 1}@ruralai-demo.invalid`,
    };
  });
}

export default {
  DATA_SOURCE,
  STATE,
  DISTRICTS,
  FACILITIES,
  buildDoctors,
  buildAssistants,
  demoPhone,
};
