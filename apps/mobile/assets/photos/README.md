# Representative photos

Shown only when a place has no photo of its own, always labelled "Representative photo · not this
place" with their credit (`src/lib/representative.ts`). They illustrate a kind of place, never a
specific venue. Demo mode (`EXPO_PUBLIC_DEMO_MODE=true`) also uses them beside its invented posts.

- `cafe.jpg` (café): https://images.unsplash.com/photo-1554118811-1e0d58224f24
- `coffee.jpg` (café): https://images.unsplash.com/photo-1509042239860-f550ce710b93
- `pastry.jpg` (dessert): https://images.unsplash.com/photo-1555507036-ab1f4038808a
- `culture.jpg` (gallery, museum, arts centre): https://images.unsplash.com/photo-1577720643272-265f09367456
- License: https://unsplash.com/license (commercial and non-commercial use permitted; credit given anyway).

To add a category: add freely licensed photos here (Unsplash License, CC0 or public domain; CC BY
only with its author and license in the credit), list them above, and map them in
`src/lib/representative.ts`. Keep the label and credit. Never map a photo of a real, named place.
