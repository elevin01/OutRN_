-- Occurrences are idempotent on their recurrence key (source host + title + start). Duplicate
-- source records must not create duplicate cards.
create unique index occurrences_recurrence_uidx on occurrences (recurrence_key) where recurrence_key is not null;
