// Deterministic SYNTHETIC Overpass-shaped fixtures for offline development and tests.
// Nothing here is a real venue. Names are invented; coordinates are jittered around the
// audit's test points. The shape (types, tags, meta) matches a real `out center tags meta`
// response so the connector, normalizer, resolver and engine run identical code paths.
//
// Regenerate: node fixtures/osm/generate.mjs
import { writeFileSync } from "node:fs";

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

function jitter(r, center, maxM) {
  const dLat = ((r() * 2 - 1) * maxM) / 111_320;
  const dLon = ((r() * 2 - 1) * maxM) / (111_320 * Math.cos((center.lat * Math.PI) / 180));
  return { lat: +(center.lat + dLat).toFixed(6), lon: +(center.lon + dLon).toFixed(6) };
}

const HOURS = {
  cafe: ["Mo-Fr 07:00-18:00; Sa-Su 08:00-18:00", "Mo-Su 07:30-17:00", "Mo-Su 08:00-20:00"],
  restaurant: ["Mo-Th 17:00-22:30; Fr-Sa 17:00-23:30; Su 17:00-22:00", "Mo-Su 11:30-15:00,17:00-22:00", "Tu-Su 12:00-23:00; Mo off", "Mo-Su 11:00-23:00"],
  bar: ["Mo-Th 17:00-02:00; Fr-Sa 16:00-04:00; Su 16:00-01:00", "Mo-Su 16:00-02:00", "Tu-Sa 18:00-03:00"],
  pub: ["Mo-Su 12:00-02:00"],
  ice_cream: ["Mo-Su 12:00-23:00"],
  museum: ["Tu-Su 11:00-18:00; Fr 11:00-21:00; Mo off", "We-Su 12:00-18:00"],
  gallery: ["Tu-Sa 11:00-18:00", "We-Su 12:00-19:00"],
  theatre: ["Tu-Su 19:00-22:30"],
  cinema: ["Mo-Su 12:00-00:00"],
  arts_centre: ["Mo-Su 10:00-22:00"],
  community_centre: ["Mo-Fr 09:00-21:00; Sa 10:00-17:00"],
  marketplace: ["Sa 08:00-16:00", "Su 10:00-17:00"],
  library: ["Mo,We 10:00-20:00; Tu,Th 10:00-18:00; Fr,Sa 10:00-17:00; Su off"],
  park: ["Mo-Su 06:00-01:00", "sunrise-sunset", "Mo-Su 06:00-22:00"],
  garden: ["Apr-Oct Mo-Su 08:00-19:00; Nov-Mar Mo-Su 08:00-17:00"],
  viewpoint: [],
  attraction: ["Mo-Su 09:00-21:00"],
  books: ["Mo-Su 10:00-21:00"],
};

const WORDS = ["Delancey", "Orchard", "Ludlow", "Rivington", "Essex", "Clinton", "Stanton", "Allen", "Broome", "Grand", "Hester", "Eldridge", "Forsyth", "Norfolk", "Suffolk", "Pitt", "Attorney", "Ridge"];
const KIND = { cafe: "Coffee", restaurant: "Kitchen", bar: "Bar", pub: "Tavern", ice_cream: "Scoops", museum: "Museum", gallery: "Gallery", theatre: "Playhouse", cinema: "Cinema", arts_centre: "Arts Center", community_centre: "Community House", marketplace: "Market", library: "Library", park: "Park", garden: "Garden", viewpoint: "Overlook", attraction: "Hall", books: "Books" };

function build(slug, center, seed, plan) {
  const r = rng(seed);
  const elements = [];
  let id = 100_000 + seed;
  const ts = (daysAgo) => new Date(Date.UTC(2026, 8, 26) - daysAgo * 86_400_000).toISOString();
  const pick = (arr) => arr[Math.floor(r() * arr.length)];
  const named = new Set();

  const add = (type, tags, point, opts = {}) => {
    const el = { type, id: opts.id ?? id++, tags, timestamp: ts(opts.daysAgo ?? Math.floor(r() * 900)), version: 1 + Math.floor(r() * 9), changeset: 1, user: "synthetic", uid: 1 };
    if (type === "node") Object.assign(el, point);
    else el.center = point;
    elements.push(el);
    return el;
  };

  for (const [key, value, count] of plan) {
    for (let i = 0; i < count; i++) {
      let name = `${pick(WORDS)} ${KIND[value] ?? value}`;
      let n = 2;
      while (named.has(name)) name = `${pick(WORDS)} ${pick(WORDS)} ${KIND[value] ?? value}`.replace(/(\w+) \1/, `$1 ${n++}`);
      named.add(name);
      const tags = { name, [key]: value };
      const hours = HOURS[value] ?? [];
      const roll = r();
      if (hours.length && roll < 0.72) tags.opening_hours = pick(hours);
      if (r() < (slug === "bronxville" ? 0.15 : 0.62)) tags.website = `https://${name.toLowerCase().replace(/[^a-z]+/g, "")}.example`;
      if (r() < 0.5) tags.phone = `+1 212 555 ${String(1000 + Math.floor(r() * 9000))}`;
      if (value === "restaurant") tags.cuisine = pick(["italian", "chinese", "japanese", "mexican", "american", "vietnamese", "korean", "pizza"]);
      if (value === "restaurant" || value === "cafe" || value === "bar") tags.outdoor_seating = r() < 0.4 ? "yes" : "no";
      if (r() < 0.25) tags.wheelchair = pick(["yes", "limited", "no"]);
      if (value === "restaurant" && r() < 0.5) tags.reservation = pick(["yes", "recommended", "required", "no"]);
      if ((value === "museum" || value === "attraction") && r() < 0.6) tags.fee = "yes";
      if (value === "park" && r() < 0.3) tags.opening_hours = "24/7";
      const type = value === "park" || value === "garden" || value === "museum" ? (r() < 0.6 ? "way" : "node") : "node";
      add(type, tags, jitter(r, center, 1400));
    }
  }

  // Deliberate identity-resolution cases (LES only, to keep Bronxville honest and small)
  if (slug === "les") {
    // 1. Same café mapped twice: node + building way, slightly different names, same website.
    const p = jitter(r, center, 600);
    add("node", { name: "Orchard St. Coffee", amenity: "cafe", website: "https://orchardstcoffee.example", opening_hours: "Mo-Su 07:00-18:00" }, p, { daysAgo: 40 });
    add("way", { name: "Orchard Street Coffee", amenity: "cafe", website: "https://orchardstcoffee.example", building: "yes" }, { lat: p.lat + 0.00012, lon: p.lon - 0.0001 }, { daysAgo: 400 });
    // 2. A chain with two branches sharing a homepage and phone: must NOT merge.
    add("node", { name: "Bagel Depot", amenity: "cafe", brand: "Bagel Depot", website: "https://bageldepot.example", phone: "+1 212 555 0100", "addr:housenumber": "12", "addr:street": "Essex Street", opening_hours: "Mo-Su 06:00-16:00" }, jitter(r, center, 900));
    add("node", { name: "Bagel Depot", amenity: "cafe", brand: "Bagel Depot", website: "https://bageldepot.example", phone: "+1 212 555 0100", "addr:housenumber": "88", "addr:street": "Rivington Street", opening_hours: "Mo-Su 06:00-16:00" }, jitter(r, center, 900));
    // 3. Museum with a café inside: venue-within-venue, not a duplicate.
    const m = jitter(r, center, 700);
    add("way", { name: "Tenement Story Museum", tourism: "museum", website: "https://tenementstory.example", opening_hours: "Tu-Su 10:00-18:30; Mo off", fee: "yes", building: "yes" }, m, { daysAgo: 20 });
    add("node", { name: "Tenement Story Museum Café", amenity: "cafe", website: "https://tenementstory.example", opening_hours: "Tu-Su 10:00-17:00", level: "0" }, { lat: m.lat + 0.00005, lon: m.lon + 0.00004 }, { daysAgo: 20 });
    // 4. Permanently closed bar still mapped with a disused tag.
    add("node", { name: "Old Norfolk Lounge", "disused:amenity": "bar", amenity: "bar", opening_hours: "off" }, jitter(r, center, 1000), { daysAgo: 30 });
    // 5. Very stale hours (last edited 6 years ago) on a restaurant.
    add("node", { name: "Hester Lane Kitchen", amenity: "restaurant", opening_hours: "Mo-Su 12:00-22:00", cuisine: "cantonese" }, jitter(r, center, 1000), { daysAgo: 2200 });
    // 6. Viewpoint with no hours (parks/viewpoints often have none) near the water.
    add("node", { name: "East River Overlook", tourism: "viewpoint", natural: "coastline" }, { lat: center.lat - 0.004, lon: center.lon + 0.012 });
    // 7. Overnight bar for DST/overnight interval tests.
    add("node", { name: "Pitt Street Nightcap", amenity: "bar", opening_hours: "Mo-Su 20:00-04:00" }, jitter(r, center, 800));
  }

  const out = {
    version: 0.6,
    generator: "outrn synthetic fixture generator (NOT real OSM data)",
    osm3s: { timestamp_osm_base: "2026-09-26T14:39:11Z", copyright: "Synthetic fixture. Shape follows Overpass output; content is invented." },
    elements,
  };
  writeFileSync(new URL(`./${slug}-synthetic.json`, import.meta.url), JSON.stringify(out, null, 1));
  console.log(`${slug}: ${elements.length} elements`);
}

build("les", { lat: 40.7185, lon: -73.988 }, 7, [
  ["amenity", "restaurant", 22], ["amenity", "cafe", 12], ["amenity", "bar", 10], ["amenity", "pub", 3], ["amenity", "ice_cream", 2],
  ["tourism", "museum", 3], ["tourism", "gallery", 6], ["amenity", "theatre", 2], ["amenity", "cinema", 2], ["amenity", "arts_centre", 1],
  ["amenity", "community_centre", 1], ["amenity", "marketplace", 1], ["amenity", "library", 1], ["leisure", "park", 5], ["leisure", "garden", 2],
  ["tourism", "attraction", 2], ["shop", "books", 2],
]);
build("bronxville", { lat: 40.941, lon: -73.835 }, 11, [
  ["amenity", "restaurant", 9], ["amenity", "cafe", 4], ["amenity", "bar", 2], ["amenity", "ice_cream", 1], ["amenity", "cinema", 1],
  ["amenity", "library", 1], ["leisure", "park", 3], ["tourism", "attraction", 1], ["shop", "books", 1],
]);
