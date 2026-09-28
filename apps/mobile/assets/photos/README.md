# Demo mood photography

Used only when `EXPO_PUBLIC_DEMO_MODE=true`, with a visible demo/illustrative label. The full demo module is gated at build time, and the export command clears the Metro cache before checking the emitted photo hashes.
These photographs illustrate a category, not the invented venues in the contract fixtures.
Production uses the existing category illustration until the API supplies accurate venue images.

- `cafe.jpg`: https://images.unsplash.com/photo-1554118811-1e0d58224f24
- `culture.jpg`: https://images.unsplash.com/photo-1577720643272-265f09367456
- `coffee.jpg`: https://images.unsplash.com/photo-1509042239860-f550ce710b93
- `pastry.jpg`: https://images.unsplash.com/photo-1555507036-ab1f4038808a
- License: https://unsplash.com/license (commercial and non-commercial use permitted).

Keep the image label and attribution when changing demo imagery. Do not associate these photos
with real venues or move them into the production data model.
