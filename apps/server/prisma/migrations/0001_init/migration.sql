-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Shanghai',
    "reminder_hour" INTEGER NOT NULL DEFAULT 9,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "wardrobes" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "owner_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "invite_code" TEXT NOT NULL,
    "default_reminder_hour" INTEGER NOT NULL DEFAULT 9,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "wardrobes_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "wardrobe_members" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "wardrobe_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'member',
    "joined_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "wardrobe_members_wardrobe_id_fkey" FOREIGN KEY ("wardrobe_id") REFERENCES "wardrobes" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "wardrobe_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "garments" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "wardrobe_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "brand" TEXT,
    "size_label" TEXT,
    "material_primary" TEXT NOT NULL,
    "material_composition" JSONB,
    "material_stretch" TEXT,
    "knit_or_woven" TEXT NOT NULL,
    "seasonTags" JSONB NOT NULL,
    "color" TEXT,
    "purchase_date" DATETIME,
    "purchase_price" DECIMAL,
    "care_wash_temp" INTEGER,
    "care_machine_wash" BOOLEAN,
    "care_dry_clean_only" BOOLEAN,
    "care_note" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "retired_at" DATETIME,
    "disposition" TEXT,
    "disposition_note" TEXT,
    "storage_location" TEXT,
    "first_wear_date" DATETIME,
    "last_washed_on" DATETIME,
    "wears_since_wash" INTEGER NOT NULL DEFAULT 0,
    "health_score" INTEGER,
    "note" TEXT,
    "created_by" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    "deleted_at" DATETIME,
    CONSTRAINT "garments_wardrobe_id_fkey" FOREIGN KEY ("wardrobe_id") REFERENCES "wardrobes" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "garments_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "garment_photos" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "garment_id" TEXT NOT NULL,
    "view" TEXT NOT NULL,
    "storage_path" TEXT NOT NULL,
    "thumb_path" TEXT NOT NULL,
    "original_name" TEXT,
    "mime_type" TEXT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "captured_at" DATETIME,
    "exif_stripped" BOOLEAN NOT NULL DEFAULT true,
    "paired_photo_id" TEXT,
    "note" TEXT,
    "created_by" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" DATETIME,
    CONSTRAINT "garment_photos_garment_id_fkey" FOREIGN KEY ("garment_id") REFERENCES "garments" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "photo_annotations" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "photo_id" TEXT NOT NULL,
    "garment_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "geometry" JSONB NOT NULL,
    "radius" REAL,
    "part_id" TEXT,
    "label" TEXT,
    "color" TEXT NOT NULL DEFAULT '#e8590c',
    "damage_event_id" TEXT,
    "repair_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "note" TEXT,
    "frozen" BOOLEAN NOT NULL DEFAULT false,
    "created_by" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "photo_annotations_photo_id_fkey" FOREIGN KEY ("photo_id") REFERENCES "garment_photos" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "photo_annotations_garment_id_fkey" FOREIGN KEY ("garment_id") REFERENCES "garments" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "photo_annotations_part_id_fkey" FOREIGN KEY ("part_id") REFERENCES "parts" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "photo_annotations_damage_event_id_fkey" FOREIGN KEY ("damage_event_id") REFERENCES "damage_events" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "photo_annotations_repair_id_fkey" FOREIGN KEY ("repair_id") REFERENCES "repairs" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "parts" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "category" TEXT,
    "parent_id" TEXT,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 100,
    "is_builtin" BOOLEAN NOT NULL DEFAULT false,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "parts_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "parts" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "damage_types" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "default_severity" TEXT NOT NULL DEFAULT 'moderate',
    "suggested_stitch_codes" JSONB NOT NULL,
    "typical_causes" JSONB NOT NULL,
    "is_builtin" BOOLEAN NOT NULL DEFAULT false,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "stitches" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "suitable_fabrics" JSONB NOT NULL,
    "suitable_damage_types" JSONB NOT NULL,
    "difficulty" TEXT NOT NULL DEFAULT 'easy',
    "typical_minutes" INTEGER,
    "requires_machine" BOOLEAN NOT NULL DEFAULT false,
    "description" TEXT NOT NULL DEFAULT '',
    "is_builtin" BOOLEAN NOT NULL DEFAULT false,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "materials" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "durability_score" INTEGER NOT NULL,
    "wash_advice" TEXT NOT NULL,
    "dry_advice" TEXT NOT NULL,
    "typical_weak_points" JSONB NOT NULL,
    "is_builtin" BOOLEAN NOT NULL DEFAULT false
);

-- CreateTable
CREATE TABLE "care_rules" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "material_code" TEXT NOT NULL,
    "wear_count_before_wash" INTEGER NOT NULL,
    "check_interval_days" INTEGER NOT NULL,
    "seasonal_check_months" JSONB NOT NULL,
    "avoid" JSONB NOT NULL,
    "observation_days_self" INTEGER NOT NULL DEFAULT 14,
    "observation_days_shop" INTEGER NOT NULL DEFAULT 7
);

-- CreateTable
CREATE TABLE "damage_events" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "garment_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "damage_type_id" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "part_id" TEXT,
    "detected_at" DATETIME NOT NULL,
    "detected_source" TEXT NOT NULL DEFAULT 'self',
    "description" TEXT,
    "cause_guess" TEXT,
    "measurable_size" JSONB,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "scheduled_at" DATETIME,
    "resolved_at" DATETIME,
    "location_unknown" BOOLEAN NOT NULL DEFAULT false,
    "location_note" TEXT,
    "recurrence_of" TEXT,
    "recurrence_index" INTEGER,
    "photos_snapshot" JSONB,
    "cancel_reason" TEXT,
    "client_op_id" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "damage_events_garment_id_fkey" FOREIGN KEY ("garment_id") REFERENCES "garments" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "damage_events_damage_type_id_fkey" FOREIGN KEY ("damage_type_id") REFERENCES "damage_types" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "damage_events_part_id_fkey" FOREIGN KEY ("part_id") REFERENCES "parts" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "damage_events_recurrence_of_fkey" FOREIGN KEY ("recurrence_of") REFERENCES "damage_events" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "repairs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "damage_event_id" TEXT NOT NULL,
    "round" INTEGER NOT NULL DEFAULT 1,
    "executed_by" TEXT NOT NULL,
    "shop_name" TEXT,
    "shop_cost" DECIMAL,
    "stitch_id" TEXT NOT NULL,
    "stitch_secondary_ids" JSONB,
    "thread_type" TEXT,
    "thread_color" TEXT,
    "duration_minutes" INTEGER,
    "cost" DECIMAL,
    "started_at" DATETIME NOT NULL,
    "finished_at" DATETIME NOT NULL,
    "result_rating" TEXT,
    "observation_days" INTEGER NOT NULL DEFAULT 14,
    "observation_until" DATETIME NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'done',
    "reuse_original_fabric" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "client_op_id" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "repairs_damage_event_id_fkey" FOREIGN KEY ("damage_event_id") REFERENCES "damage_events" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "repairs_stitch_id_fkey" FOREIGN KEY ("stitch_id") REFERENCES "stitches" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "repair_materials" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "repair_id" TEXT NOT NULL,
    "fabric_source_id" TEXT NOT NULL,
    "amount" REAL NOT NULL,
    "unit" TEXT NOT NULL,
    "note" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "repair_materials_repair_id_fkey" FOREIGN KEY ("repair_id") REFERENCES "repairs" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "repair_materials_fabric_source_id_fkey" FOREIGN KEY ("fabric_source_id") REFERENCES "fabric_sources" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "repair_changes" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "repair_id" TEXT NOT NULL,
    "visibility" TEXT NOT NULL,
    "color_match" TEXT NOT NULL,
    "dimension_change" JSONB,
    "stiffness" TEXT NOT NULL,
    "drape_change" TEXT NOT NULL,
    "comfort_note" TEXT,
    "mobility_limited" BOOLEAN NOT NULL DEFAULT false,
    "visible_from_outside" BOOLEAN NOT NULL DEFAULT false,
    "photo_before_id" TEXT,
    "photo_after_id" TEXT,
    "wear_test_note" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "repair_changes_repair_id_fkey" FOREIGN KEY ("repair_id") REFERENCES "repairs" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "review_results" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "repair_id" TEXT NOT NULL,
    "reviewed_at" DATETIME NOT NULL,
    "verdict" TEXT NOT NULL,
    "worn_since" INTEGER,
    "days_since_repair" INTEGER NOT NULL,
    "reoccurred" BOOLEAN NOT NULL DEFAULT false,
    "verdict_note" TEXT,
    "next_action" TEXT NOT NULL,
    "triggered_repair_id" TEXT,
    "source_reminder_id" TEXT,
    "created_by" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "review_results_repair_id_fkey" FOREIGN KEY ("repair_id") REFERENCES "repairs" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "wear_logs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "garment_id" TEXT NOT NULL,
    "worn_on" DATETIME NOT NULL,
    "session" TEXT NOT NULL DEFAULT 'full_day',
    "season_snapshot" TEXT NOT NULL,
    "weather_snapshot" JSONB,
    "occasion" TEXT,
    "intensity" TEXT NOT NULL DEFAULT 'normal',
    "note" TEXT,
    "client_op_id" TEXT,
    "created_by" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "wear_logs_garment_id_fkey" FOREIGN KEY ("garment_id") REFERENCES "garments" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "fabric_sources" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "wardrobe_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "donor_garment_id" TEXT,
    "material_primary" TEXT NOT NULL,
    "color" TEXT,
    "composition_note" TEXT,
    "price" DECIMAL,
    "purchase_date" DATETIME,
    "purchase_location" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "fabric_sources_wardrobe_id_fkey" FOREIGN KEY ("wardrobe_id") REFERENCES "wardrobes" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "fabric_sources_donor_garment_id_fkey" FOREIGN KEY ("donor_garment_id") REFERENCES "garments" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "fabric_inventory" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "fabric_source_id" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "initial_amount" REAL NOT NULL,
    "remaining_amount" REAL NOT NULL,
    "low_stock_threshold" REAL NOT NULL,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "fabric_inventory_fabric_source_id_fkey" FOREIGN KEY ("fabric_source_id") REFERENCES "fabric_sources" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "inventory_txns" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "inventory_id" TEXT NOT NULL,
    "repair_id" TEXT,
    "direction" TEXT NOT NULL,
    "amount" REAL NOT NULL,
    "reason" TEXT,
    "created_by" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "inventory_txns_inventory_id_fkey" FOREIGN KEY ("inventory_id") REFERENCES "fabric_inventory" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "inventory_txns_repair_id_fkey" FOREIGN KEY ("repair_id") REFERENCES "repairs" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "reminder_rules" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "wardrobe_id" TEXT NOT NULL,
    "code" TEXT,
    "name" TEXT NOT NULL,
    "trigger_kind" TEXT NOT NULL,
    "params" JSONB NOT NULL,
    "scope_filter" JSONB NOT NULL,
    "schedule_cron" TEXT NOT NULL DEFAULT '0 * * * *',
    "channel" TEXT NOT NULL DEFAULT 'inapp',
    "priority" TEXT NOT NULL DEFAULT 'normal',
    "is_enabled" BOOLEAN NOT NULL DEFAULT true,
    "is_builtin" BOOLEAN NOT NULL DEFAULT false,
    "last_run_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "reminder_rules_wardrobe_id_fkey" FOREIGN KEY ("wardrobe_id") REFERENCES "wardrobes" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "reminders" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "wardrobe_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "rule_id" TEXT,
    "subject_type" TEXT NOT NULL,
    "subject_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "action_kind" TEXT NOT NULL,
    "action_payload" JSONB,
    "due_at" DATETIME NOT NULL,
    "expire_at" DATETIME NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "occurrence_key" TEXT NOT NULL,
    "notified_at" DATETIME,
    "handled_at" DATETIME,
    "handled_by" TEXT,
    "snooze_until" DATETIME,
    "dismiss_reason" TEXT,
    "dismiss_note" TEXT,
    "result_ref" JSONB,
    "priority" TEXT NOT NULL DEFAULT 'normal',
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "reminders_wardrobe_id_fkey" FOREIGN KEY ("wardrobe_id") REFERENCES "wardrobes" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "reminders_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "reminders_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "reminder_rules" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "share_links" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "wardrobe_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'garment',
    "garmentIds" JSONB NOT NULL,
    "expires_at" DATETIME NOT NULL,
    "access_count" INTEGER NOT NULL DEFAULT 0,
    "last_access_at" DATETIME,
    "created_by" TEXT NOT NULL,
    "revoked_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "share_links_wardrobe_id_fkey" FOREIGN KEY ("wardrobe_id") REFERENCES "wardrobes" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "activity_logs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "wardrobe_id" TEXT NOT NULL,
    "actor_id" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "diff" JSONB,
    "request_id" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "activity_logs_wardrobe_id_fkey" FOREIGN KEY ("wardrobe_id") REFERENCES "wardrobes" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "wardrobes_invite_code_key" ON "wardrobes"("invite_code");

-- CreateIndex
CREATE UNIQUE INDEX "wardrobe_members_wardrobe_id_user_id_key" ON "wardrobe_members"("wardrobe_id", "user_id");

-- CreateIndex
CREATE INDEX "garments_wardrobe_id_status_idx" ON "garments"("wardrobe_id", "status");

-- CreateIndex
CREATE INDEX "garments_wardrobe_id_material_primary_idx" ON "garments"("wardrobe_id", "material_primary");

-- CreateIndex
CREATE INDEX "garments_wardrobe_id_status_updated_at_idx" ON "garments"("wardrobe_id", "status", "updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "garments_wardrobe_id_code_key" ON "garments"("wardrobe_id", "code");

-- CreateIndex
CREATE INDEX "garment_photos_garment_id_view_idx" ON "garment_photos"("garment_id", "view");

-- CreateIndex
CREATE INDEX "photo_annotations_photo_id_idx" ON "photo_annotations"("photo_id");

-- CreateIndex
CREATE INDEX "photo_annotations_garment_id_status_idx" ON "photo_annotations"("garment_id", "status");

-- CreateIndex
CREATE INDEX "photo_annotations_damage_event_id_idx" ON "photo_annotations"("damage_event_id");

-- CreateIndex
CREATE UNIQUE INDEX "parts_code_key" ON "parts"("code");

-- CreateIndex
CREATE UNIQUE INDEX "damage_types_code_key" ON "damage_types"("code");

-- CreateIndex
CREATE UNIQUE INDEX "stitches_code_key" ON "stitches"("code");

-- CreateIndex
CREATE UNIQUE INDEX "materials_code_key" ON "materials"("code");

-- CreateIndex
CREATE UNIQUE INDEX "care_rules_material_code_key" ON "care_rules"("material_code");

-- CreateIndex
CREATE UNIQUE INDEX "damage_events_client_op_id_key" ON "damage_events"("client_op_id");

-- CreateIndex
CREATE INDEX "damage_events_garment_id_status_idx" ON "damage_events"("garment_id", "status");

-- CreateIndex
CREATE INDEX "damage_events_garment_id_part_id_damage_type_id_idx" ON "damage_events"("garment_id", "part_id", "damage_type_id");

-- CreateIndex
CREATE INDEX "damage_events_recurrence_of_idx" ON "damage_events"("recurrence_of");

-- CreateIndex
CREATE UNIQUE INDEX "damage_events_garment_id_code_key" ON "damage_events"("garment_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "repairs_client_op_id_key" ON "repairs"("client_op_id");

-- CreateIndex
CREATE INDEX "repairs_status_observation_until_idx" ON "repairs"("status", "observation_until");

-- CreateIndex
CREATE UNIQUE INDEX "repairs_damage_event_id_round_key" ON "repairs"("damage_event_id", "round");

-- CreateIndex
CREATE INDEX "repair_materials_repair_id_idx" ON "repair_materials"("repair_id");

-- CreateIndex
CREATE UNIQUE INDEX "repair_changes_repair_id_key" ON "repair_changes"("repair_id");

-- CreateIndex
CREATE INDEX "review_results_repair_id_idx" ON "review_results"("repair_id");

-- CreateIndex
CREATE INDEX "review_results_reviewed_at_idx" ON "review_results"("reviewed_at");

-- CreateIndex
CREATE UNIQUE INDEX "wear_logs_client_op_id_key" ON "wear_logs"("client_op_id");

-- CreateIndex
CREATE INDEX "wear_logs_garment_id_worn_on_idx" ON "wear_logs"("garment_id", "worn_on");

-- CreateIndex
CREATE UNIQUE INDEX "wear_logs_garment_id_worn_on_key" ON "wear_logs"("garment_id", "worn_on");

-- CreateIndex
CREATE INDEX "fabric_sources_wardrobe_id_is_active_idx" ON "fabric_sources"("wardrobe_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "fabric_inventory_fabric_source_id_key" ON "fabric_inventory"("fabric_source_id");

-- CreateIndex
CREATE INDEX "inventory_txns_inventory_id_created_at_idx" ON "inventory_txns"("inventory_id", "created_at");

-- CreateIndex
CREATE INDEX "reminder_rules_wardrobe_id_is_enabled_idx" ON "reminder_rules"("wardrobe_id", "is_enabled");

-- CreateIndex
CREATE UNIQUE INDEX "reminder_rules_wardrobe_id_code_key" ON "reminder_rules"("wardrobe_id", "code");

-- CreateIndex
CREATE INDEX "reminders_user_id_status_due_at_idx" ON "reminders"("user_id", "status", "due_at");

-- CreateIndex
CREATE UNIQUE INDEX "reminders_subject_type_subject_id_occurrence_key_key" ON "reminders"("subject_type", "subject_id", "occurrence_key");

-- CreateIndex
CREATE UNIQUE INDEX "share_links_token_hash_key" ON "share_links"("token_hash");

-- CreateIndex
CREATE INDEX "share_links_wardrobe_id_idx" ON "share_links"("wardrobe_id");

-- CreateIndex
CREATE INDEX "activity_logs_wardrobe_id_created_at_idx" ON "activity_logs"("wardrobe_id", "created_at");

-- CreateIndex
CREATE INDEX "activity_logs_entity_type_entity_id_idx" ON "activity_logs"("entity_type", "entity_id");

