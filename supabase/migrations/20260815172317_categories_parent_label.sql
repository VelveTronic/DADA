-- Category group label (freepos parent tier). A label, not a foreign key: the
-- parent tier in freepos is a display grouping; normalize only if the UI ever
-- needs parent-level operations.
alter table public.categories add column parent_label jsonb;
