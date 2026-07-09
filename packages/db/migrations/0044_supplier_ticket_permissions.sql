INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT "role_id", 'supplier.tickets.view'
FROM "role_permissions"
WHERE "permission_id" = 'supplier.cases.view';
--> statement-breakpoint
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT "role_id", 'supplier.tickets.respond'
FROM "role_permissions"
WHERE "permission_id" = 'supplier.cases.respond';
--> statement-breakpoint
DELETE FROM "role_permissions"
WHERE "permission_id" IN ('supplier.cases.view', 'supplier.cases.respond');
