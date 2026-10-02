# Events: what's happening

OutRN pushes what is only happening now: fireworks, a band in the park, a street fair, a pop-up
market. Events reach the engine from three places:

- **A venue's own website**, read by the first-party job (`schema.org` events in its JSON-LD). Their
  types say what they are: a `MusicEvent` is live music, a `ComedyEvent` comedy, a `Festival` a
  festival.
- **An events file** (`outrn ingest events`): the founder's own list today, and the shape every
  feed (NYC Parks, libraries, ticketing) is converted to as it is added.
- **Fixtures** for tests.

## An events file

```json
{
  "source": "founder",
  "events": [
    {
      "id": "east-river-fireworks-2026-10-10",
      "title": "Fireworks over the East River",
      "start": "2026-10-10T20:00:00-04:00",
      "end": "2026-10-10T20:30:00-04:00",
      "kinds": ["festivals"],
      "admission": "walk_in",
      "price": { "free": true },
      "place": { "name": "East River Esplanade at Grand St", "lat": 40.7135, "lon": -73.9775 },
      "url": "https://example.org/fireworks",
      "evidence": "city press release, 10/1"
    },
    {
      "id": "jazz-night-2026-10-09",
      "title": "Jazz Night (21+)",
      "start": "2026-10-09T20:00:00-04:00",
      "kinds": ["live_music"],
      "place": { "venue": "Hester Lane Kitchen" },
      "evidence": "their Instagram, 10/2"
    }
  ]
}
```

```
pnpm outrn ingest events --area les --from-file events.json
```

- **`id`** is stable for the source. The same id updates the same event: a new time, a new title,
  or `"status": "cancelled"` when it is called off. An event left out of a later file is not
  removed; cancel it.
- **`place`** is either a venue we know (`"venue"`: its id, or a name that is exactly one venue in
  the area), or a place of its own (`"name"`, `"lat"`, `"lon"`) inside the area.
  - A place of its own becomes an **event site**: a venue shown only through its events, never on
    its own. The same name within 75 m is the same site, so a weekly market's events share one.
  - A site is never merged into a place nearby or made its child, and a place nearby is never
    matched to a site or made a site's child.
- **`kinds`**: what it is, as interests (`live_music`, `comedy`, `theatre`, `film`, `art`,
  `museums`, `food`, `cafes`, `drinks`, `nightlife`, `outdoors`, `games`, `markets`, `books`,
  `sports`, `festivals`), at most 4. Without them the title is read ("Jazz on the Lawn" is live
  music). They rank the event for people who like that kind of thing.
- **`admission`** (`walk_in`, `ticket`, `reservation`): a walk-in pop-up at its own site can be
  joined after it starts. Without it, the event is Check first.
- **`price`**: `{ "free": true }`, or `{ "min": 10, "max": 25, "currency": "USD" }`.
- **`minAge`**: the age to get in, as the event states it. A title's "21+" or "18+" counts too. A
  drink event (its kinds include `drinks`, or its title says so: a wine tasting, a beer garden, a
  happy hour, a brewery night) with no age stated by it or its venue is taken as probably 21+,
  wherever it is held: Check first for a party with a child, "usually 21+" for adults. A cheese or
  coffee tasting is not a drink event. An all-ages event says `"minAge": 0`.
- **`url`**: the event's own page, https only.
- **`evidence`**: how you know. Required for the founder's own list.

Every event is checked before anything is written: times that make sense (an end after the start,
at most 14 days long, at most 400 days ahead, not over), a place inside the area, kinds that are
interests, an https link, no control or text-direction characters, an id once per file. One that fails is left out
with the reason, and the rest are written; the command exits non-zero when anything was left out.
