-- Sales Officer territory (separate from name and from the group/region). Nullable; admin-editable.
ALTER TABLE "User" ADD COLUMN "territory" TEXT;
