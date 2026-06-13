CREATE TABLE "roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"is_owner" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "role_permissions" (
	"role_id" uuid NOT NULL,
	"permission_id" text NOT NULL,
	CONSTRAINT "role_permissions_role_id_permission_id_pk" PRIMARY KEY("role_id","permission_id")
);
--> statement-breakpoint
CREATE TABLE "member_role_assignments" (
	"tenant_id" uuid NOT NULL,
	"user_decision_uuid" uuid NOT NULL,
	"email" text NOT NULL,
	"workos_user_id" text,
	"role_id" uuid NOT NULL,
	"invited_by_uuid" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "member_role_assignments_tenant_id_user_decision_uuid_pk" PRIMARY KEY("tenant_id","user_decision_uuid")
);
--> statement-breakpoint
CREATE TABLE "member_invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role_id" uuid NOT NULL,
	"workos_invitation_id" text,
	"invited_by_uuid" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"accepted_at" timestamp with time zone,
	CONSTRAINT "member_invitations_status_check" CHECK ("member_invitations"."status" IN ('pending','accepted','revoked','expired'))
);
--> statement-breakpoint
ALTER TABLE "roles" ADD CONSTRAINT "roles_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_role_assignments" ADD CONSTRAINT "member_role_assignments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_role_assignments" ADD CONSTRAINT "member_role_assignments_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_invitations" ADD CONSTRAINT "member_invitations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_invitations" ADD CONSTRAINT "member_invitations_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "roles_tenant_name_unique" ON "roles" USING btree ("tenant_id",lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "roles_tenant_owner_unique" ON "roles" USING btree ("tenant_id") WHERE "roles"."is_owner";--> statement-breakpoint
CREATE INDEX "roles_tenant_idx" ON "roles" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "role_permissions_role_idx" ON "role_permissions" USING btree ("role_id");--> statement-breakpoint
CREATE INDEX "member_role_assignments_tenant_idx" ON "member_role_assignments" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "member_role_assignments_role_idx" ON "member_role_assignments" USING btree ("role_id");--> statement-breakpoint
CREATE UNIQUE INDEX "member_invitations_tenant_email_pending_unique" ON "member_invitations" USING btree ("tenant_id",lower("email")) WHERE "member_invitations"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "member_invitations_tenant_idx" ON "member_invitations" USING btree ("tenant_id");--> statement-breakpoint
-- Backfill: seed an Owner role for every existing dashboard-connected workspace
-- so the merchant has an all-access role to assign immediately. Member
-- assignments are created at runtime (the migration has no decision UUIDs); a
-- workspace with zero assignments stays in "open" mode so the incumbent
-- operator is never locked out.
INSERT INTO "roles" ("tenant_id", "name", "is_owner")
SELECT "id", 'Owner', true FROM "tenants" WHERE "workos_organization_id" IS NOT NULL;
