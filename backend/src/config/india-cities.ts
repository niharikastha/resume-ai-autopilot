/**
 * The places a candidate can choose from, and the words a job posting uses for them.
 *
 * ONE CATALOGUE, SERVED TO THE UI. The checkbox list on the preferences screen is
 * rendered from this array over the API rather than typed out again in the frontend.
 * A second copy would drift, and the failure mode of drift here is silent: a city the
 * UI offers but the matcher does not recognise looks like a working choice and rejects
 * every job in that city forever.
 *
 * A CHOICE IS ONE PLACE; A MATCH NEEDS MANY WORDS. "Delhi NCR" is one thing a person
 * means and at least six things an employer writes - New Delhi, Delhi, Gurgaon,
 * Gurugram, Noida, Faridabad. Asking somebody to tick six boxes to express one
 * intention is how a preference screen ends up half-filled, so the grouping lives
 * here and the stored preference is the id.
 *
 * TERMS ARE MATCHED AT WORD BOUNDARIES by stage 1, which is why short ones are safe
 * to list: `pune` does not fire inside "Puneet" and `ind` does not fire inside
 * "Indiana". Without that guarantee half of this file would be unusable - see
 * `patternFor` in stage1.screen.ts.
 */

export interface IndiaCity {
  /** Stable id, stored in JobPreference.cities. Never re-used for another place. */
  id: string;
  /** What the checkbox says. */
  label: string;
  /**
   * Every spelling a posting might use, lower case.
   *
   * Includes the label's own words: the matcher only ever sees this list, so a term
   * missing from it is a city the candidate ticked and will never be offered a job in.
   */
  terms: string[];
  /**
   * Part of the "big metros" preset.
   *
   * The eight cities that carry the overwhelming majority of Indian software
   * postings. Offered as a preset because "the big cities" is a real intention that
   * would otherwise be eight separate clicks, and because a candidate open to
   * relocating usually means exactly this set.
   */
  metro: boolean;
}

/**
 * Ordered so the list reads sensibly on screen: the metros first, then everywhere
 * else alphabetically. Not sorted by population - a preference screen is read, not
 * ranked.
 */
export const INDIA_CITIES: readonly IndiaCity[] = [
  {
    id: 'bengaluru',
    label: 'Bengaluru',
    terms: ['bengaluru', 'bangalore', 'bangaluru'],
    metro: true,
  },
  { id: 'hyderabad', label: 'Hyderabad', terms: ['hyderabad'], metro: true },
  { id: 'pune', label: 'Pune', terms: ['pune'], metro: true },
  {
    id: 'chennai',
    label: 'Chennai',
    terms: ['chennai', 'madras'],
    metro: true,
  },
  {
    id: 'mumbai',
    label: 'Mumbai',
    // Navi Mumbai and Thane are separate municipalities and the same commute.
    terms: ['mumbai', 'navi mumbai', 'thane', 'bombay'],
    metro: true,
  },
  {
    id: 'delhi-ncr',
    label: 'Delhi NCR',
    terms: [
      'new delhi',
      'delhi',
      'gurgaon',
      'gurugram',
      'noida',
      'greater noida',
      'faridabad',
      'ghaziabad',
      'ncr',
    ],
    metro: true,
  },
  {
    id: 'kolkata',
    label: 'Kolkata',
    terms: ['kolkata', 'calcutta'],
    metro: true,
  },
  {
    id: 'ahmedabad',
    label: 'Ahmedabad',
    terms: ['ahmedabad', 'gandhinagar'],
    metro: true,
  },
  {
    id: 'bhubaneswar',
    label: 'Bhubaneswar',
    terms: ['bhubaneswar', 'bhubaneshwar', 'cuttack'],
    metro: false,
  },
  {
    id: 'chandigarh',
    label: 'Chandigarh / Mohali',
    terms: ['chandigarh', 'mohali', 'panchkula', 'zirakpur'],
    metro: false,
  },
  {
    id: 'coimbatore',
    label: 'Coimbatore',
    terms: ['coimbatore'],
    metro: false,
  },
  { id: 'indore', label: 'Indore', terms: ['indore'], metro: false },
  { id: 'jaipur', label: 'Jaipur', terms: ['jaipur'], metro: false },
  {
    id: 'kochi',
    label: 'Kochi',
    terms: ['kochi', 'cochin', 'ernakulam', 'infopark'],
    metro: false,
  },
  { id: 'lucknow', label: 'Lucknow', terms: ['lucknow'], metro: false },
  { id: 'mysuru', label: 'Mysuru', terms: ['mysuru', 'mysore'], metro: false },
  { id: 'nagpur', label: 'Nagpur', terms: ['nagpur'], metro: false },
  {
    id: 'thiruvananthapuram',
    label: 'Thiruvananthapuram',
    terms: ['thiruvananthapuram', 'trivandrum', 'technopark'],
    metro: false,
  },
  {
    id: 'vadodara',
    label: 'Vadodara',
    terms: ['vadodara', 'baroda'],
    metro: false,
  },
  {
    id: 'visakhapatnam',
    label: 'Visakhapatnam',
    terms: ['visakhapatnam', 'vizag', 'vishakhapatnam'],
    metro: false,
  },
];

/** Every id, for validating what the UI sends back. */
export const CITY_IDS: ReadonlySet<string> = new Set(
  INDIA_CITIES.map((city) => city.id),
);

/** The preset. */
export const METRO_CITY_IDS: readonly string[] = INDIA_CITIES.filter(
  (city) => city.metro,
).map((city) => city.id);

/**
 * The words that mean "somewhere in India" without naming a city.
 *
 * `ind` is here because it is a real spelling and a measured loss: Zscaler writes
 * "Mohali, IND", and with only `india` in the vocabulary that string named nowhere -
 * the posting was classified UNKNOWN and dropped for having an unrecognised location.
 */
export const INDIA_TERMS: readonly string[] = ['india', 'ind', 'bharat'];

/** The match terms for a set of chosen city ids. Unknown ids are ignored. */
export function termsForCities(ids: readonly string[]): string[] {
  const chosen = new Set(ids);
  return INDIA_CITIES.filter((city) => chosen.has(city.id)).flatMap(
    (city) => city.terms,
  );
}

/**
 * Every term in the catalogue, plus the country words.
 *
 * What "anywhere in India" expands to. The country words alone would be nearly
 * enough - most postings name the country - but not quite: "Gurugram" on its own is
 * a complete location string on several boards, and a candidate who said "anywhere in
 * India" would not expect it to be thrown out for omitting the word India.
 */
export function allIndiaTerms(): string[] {
  return [...INDIA_TERMS, ...INDIA_CITIES.flatMap((city) => city.terms)];
}
