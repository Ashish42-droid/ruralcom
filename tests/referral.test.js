/**
 * Hospital ranking and distance — pure logic, no database.
 *
 * The ranking encodes a clinical judgement: capability and a free bed
 * outrank proximity. Sending a critical patient to the nearest hospital
 * that cannot admit them is the costliest possible mistake in a
 * time-critical transfer, so these tests pin the ordering.
 */
import {
  haversineKm,
  rankHospitals,
  LONG_TRANSFER_WARNING_KM,
  STALE_CAPACITY_SECONDS,
} from '../services/referral.service.js';

const KANPUR = { lat: 26.4499, lng: 80.3319 };

/** Builds a candidate in the shape the Supabase join returns. */
const hospital = (name, lat, lng, capacity = {}) => ({
  id: `id-${name}`,
  name,
  type: capacity.type ?? 'district_hospital',
  contact: '+91-00000-00001',
  address: `${name} Road`,
  latitude: lat,
  longitude: lng,
  hospital_capacity: capacity.none
    ? null
    : {
        total_beds: capacity.total ?? 100,
        available_beds: capacity.available ?? 10,
        icu_available: capacity.icu ?? 2,
        has_emergency: capacity.emergency ?? true,
        has_ambulance: capacity.ambulance ?? true,
        last_updated_at: capacity.updatedAt ?? new Date().toISOString(),
        data_source: capacity.source ?? 'PLACEHOLDER_DEMO',
      },
});

describe('haversineKm', () => {
  it('is zero for the same point', () => {
    expect(haversineKm(KANPUR, KANPUR)).toBe(0);
  });

  it('computes a known distance plausibly', () => {
    // Kanpur to Unnao is roughly 17 km straight-line.
    const unnao = { lat: 26.5464, lng: 80.4879 };
    const d = haversineKm(KANPUR, unnao);
    expect(d).toBeGreaterThan(12);
    expect(d).toBeLessThan(25);
  });

  it('is symmetric', () => {
    const a = { lat: 26.4, lng: 80.3 };
    const b = { lat: 26.8, lng: 80.1 };
    expect(haversineKm(a, b)).toBe(haversineKm(b, a));
  });

  it('returns null rather than NaN when a coordinate is missing', () => {
    expect(haversineKm(KANPUR, { lat: null, lng: 80 })).toBeNull();
    expect(haversineKm(KANPUR, {})).toBeNull();
    expect(haversineKm(null, KANPUR)).toBeNull();
  });
});

describe('ranking puts a usable bed ahead of proximity', () => {
  it('prefers a further hospital WITH beds over a nearer one without', () => {
    const ranked = rankHospitals({
      origin: KANPUR,
      candidates: [
        hospital('Near But Full', 26.45, 80.34, { available: 0 }),
        hospital('Further With Beds', 26.9, 80.9, { available: 20 }),
      ],
    });

    // The nearest hospital that cannot admit is not a destination.
    expect(ranked[0].name).toBe('Further With Beds');
    expect(ranked[1].name).toBe('Near But Full');
  });

  it('still RETURNS the full hospital rather than hiding it', () => {
    // When everything nearby is full the assistant needs to see that and
    // telephone, not be shown an empty list.
    const ranked = rankHospitals({
      origin: KANPUR,
      candidates: [hospital('All Full', 26.45, 80.34, { available: 0 })],
    });

    expect(ranked).toHaveLength(1);
    expect(ranked[0].availableBeds).toBe(0);
  });

  it('prefers emergency capability when bed position is equal', () => {
    const ranked = rankHospitals({
      origin: KANPUR,
      candidates: [
        hospital('No Emergency', 26.45, 80.33, { available: 10, emergency: false, type: 'chc' }),
        hospital('With Emergency', 26.7, 80.7, { available: 10, emergency: true }),
      ],
    });

    expect(ranked[0].name).toBe('With Emergency');
  });

  it('falls back to distance once capability and beds match', () => {
    const ranked = rankHospitals({
      origin: KANPUR,
      candidates: [
        hospital('Far', 27.5, 81.5, { available: 10 }),
        hospital('Near', 26.46, 80.34, { available: 10 }),
        hospital('Middle', 26.9, 80.7, { available: 10 }),
      ],
    });

    expect(ranked.map((h) => h.name)).toEqual(['Near', 'Middle', 'Far']);
  });

  it('sorts an unknown distance last rather than treating it as nearby', () => {
    const ranked = rankHospitals({
      origin: KANPUR,
      candidates: [
        hospital('No Coordinates', null, null, { available: 10 }),
        hospital('Known', 26.9, 80.7, { available: 10 }),
      ],
    });

    expect(ranked[0].name).toBe('Known');
    expect(ranked[1].distanceKm).toBeNull();
  });
});

describe('capability filtering', () => {
  it('excludes a CHC with no emergency capability', () => {
    const ranked = rankHospitals({
      origin: KANPUR,
      candidates: [hospital('Plain CHC', 26.45, 80.33, { emergency: false, type: 'chc' })],
    });
    expect(ranked).toHaveLength(0);
  });

  it('keeps a district hospital even with the emergency flag unset', () => {
    // A district hospital is the referral destination of last resort; it
    // must not vanish from the list because of a missing capability flag.
    const ranked = rankHospitals({
      origin: KANPUR,
      candidates: [
        hospital('District', 26.45, 80.33, { emergency: false, type: 'district_hospital' }),
      ],
    });
    expect(ranked).toHaveLength(1);
  });

  it('keeps everything when emergency capability is not required', () => {
    const ranked = rankHospitals({
      origin: KANPUR,
      requireEmergency: false,
      candidates: [hospital('Plain CHC', 26.45, 80.33, { emergency: false, type: 'chc' })],
    });
    expect(ranked).toHaveLength(1);
  });
});

describe('honesty flags', () => {
  it('marks stale capacity', () => {
    const old = new Date(Date.now() - (STALE_CAPACITY_SECONDS + 60) * 1000).toISOString();
    const [h] = rankHospitals({
      origin: KANPUR,
      candidates: [hospital('Stale', 26.45, 80.33, { updatedAt: old })],
    });

    expect(h.capacityIsStale).toBe(true);
    expect(h.capacityAgeSeconds).toBeGreaterThan(STALE_CAPACITY_SECONDS);
  });

  it('does not mark fresh capacity as stale', () => {
    const [h] = rankHospitals({
      origin: KANPUR,
      candidates: [hospital('Fresh', 26.45, 80.33, {})],
    });
    expect(h.capacityIsStale).toBe(false);
  });

  it('treats a hospital with NO capacity record as stale, not as empty-but-fine', () => {
    // Absence of data is not evidence of availability.
    const [h] = rankHospitals({
      origin: KANPUR,
      candidates: [hospital('Unknown', 26.45, 80.33, { none: true, type: 'district_hospital' })],
    });

    expect(h.hasCapacityData).toBe(false);
    expect(h.capacityIsStale).toBe(true);
    expect(h.availableBeds).toBe(0);
  });

  it('flags a long transfer', () => {
    const [h] = rankHospitals({
      origin: KANPUR,
      // Roughly 2 degrees of latitude ~ 220 km.
      candidates: [hospital('Very Far', 28.5, 80.33, {})],
    });

    expect(h.distanceKm).toBeGreaterThan(LONG_TRANSFER_WARNING_KM);
    expect(h.longTransfer).toBe(true);
  });

  it('always labels the distance basis as straight-line', () => {
    const ranked = rankHospitals({
      origin: KANPUR,
      candidates: [hospital('Any', 26.5, 80.4, {})],
    });
    // Road distance in rural terrain can be several times this.
    expect(ranked[0].distanceBasis).toBe('straight_line');
  });

  it('surfaces the capacity data source so demo data is identifiable', () => {
    const [h] = rankHospitals({
      origin: KANPUR,
      candidates: [hospital('Demo', 26.5, 80.4, { source: 'PLACEHOLDER_DEMO' })],
    });
    expect(h.capacityDataSource).toBe('PLACEHOLDER_DEMO');
  });
});

describe('empty input', () => {
  it('returns an empty list rather than throwing', () => {
    expect(rankHospitals({ origin: KANPUR, candidates: [] })).toEqual([]);
  });
});
