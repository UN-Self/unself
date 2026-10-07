-- SPDX-License-Identifier: GPL-3.0-only
ALTER TABLE users ADD COLUMN core_profile_revision INTEGER NOT NULL DEFAULT -1;
