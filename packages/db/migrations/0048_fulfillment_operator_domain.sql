-- One-way Supplier -> Fulfillment Operator domain migration. Historical
-- migrations retain the names they originally shipped; the live schema and
-- persisted machine identities do not retain compatibility aliases.

-- Physical logistics schema.
ALTER TABLE "suppliers" RENAME TO "fulfillment_operators";
ALTER TABLE "ticket_supplier_escalations" RENAME TO "ticket_fulfillment_operator_escalations";
ALTER TABLE "ticket_fulfillment_operator_escalations" RENAME COLUMN "supplier_id" TO "fulfillment_operator_id";

ALTER TABLE "fulfillment_operators" RENAME CONSTRAINT "suppliers_pkey" TO "fulfillment_operators_pkey";
ALTER TABLE "fulfillment_operators" RENAME CONSTRAINT "suppliers_tenant_id_tenants_id_fk" TO "fulfillment_operators_tenant_id_tenants_id_fk";
ALTER TABLE "ticket_fulfillment_operator_escalations" RENAME CONSTRAINT "case_supplier_escalations_pkey" TO "fulfillment_operator_escalations_pkey";
ALTER TABLE "ticket_fulfillment_operator_escalations" RENAME CONSTRAINT "ticket_supplier_escalations_tenant_id_tenants_id_fk" TO "fulfillment_operator_escalations_tenant_id_fk";
ALTER TABLE "ticket_fulfillment_operator_escalations" RENAME CONSTRAINT "ticket_supplier_escalations_ticket_id_tickets_id_fk" TO "fulfillment_operator_escalations_ticket_id_fk";
ALTER TABLE "ticket_fulfillment_operator_escalations" RENAME CONSTRAINT "ticket_supplier_escalations_supplier_id_suppliers_id_fk" TO "fulfillment_operator_escalations_operator_id_fk";
ALTER TABLE "ticket_fulfillment_operator_escalations" RENAME CONSTRAINT "ticket_supplier_escalations_status_check" TO "fulfillment_operator_escalations_status_check";
ALTER TABLE "ticket_attachments" RENAME CONSTRAINT "ticket_attachments_escalation_id_ticket_supplier_escalations_id" TO "ticket_attachments_operator_escalation_id_fk";

-- PostgreSQL 18 represents NOT NULL constraints as named catalog objects.
-- Older supported versions do not, so rename them only when present.
DO $$
DECLARE
  item record;
BEGIN
  FOR item IN
    SELECT *
    FROM (VALUES
      ('fulfillment_operators', 'suppliers_id_not_null', 'fulfillment_operators_id_not_null'),
      ('fulfillment_operators', 'suppliers_tenant_id_not_null', 'fulfillment_operators_tenant_id_not_null'),
      ('fulfillment_operators', 'suppliers_name_not_null', 'fulfillment_operators_name_not_null'),
      ('fulfillment_operators', 'suppliers_email_not_null', 'fulfillment_operators_email_not_null'),
      ('fulfillment_operators', 'suppliers_created_at_not_null', 'fulfillment_operators_created_at_not_null'),
      ('ticket_fulfillment_operator_escalations', 'case_supplier_escalations_id_not_null', 'fulfillment_operator_escalations_id_not_null'),
      ('ticket_fulfillment_operator_escalations', 'case_supplier_escalations_tenant_id_not_null', 'fulfillment_operator_escalations_tenant_id_not_null'),
      ('ticket_fulfillment_operator_escalations', 'case_supplier_escalations_case_id_not_null', 'fulfillment_operator_escalations_ticket_id_not_null'),
      ('ticket_fulfillment_operator_escalations', 'case_supplier_escalations_supplier_id_not_null', 'fulfillment_operator_escalations_operator_id_not_null'),
      ('ticket_fulfillment_operator_escalations', 'case_supplier_escalations_problem_not_null', 'fulfillment_operator_escalations_problem_not_null'),
      ('ticket_fulfillment_operator_escalations', 'case_supplier_escalations_status_not_null', 'fulfillment_operator_escalations_status_not_null'),
      ('ticket_fulfillment_operator_escalations', 'case_supplier_escalations_notify_attempts_not_null', 'fulfillment_operator_escalations_notify_attempts_not_null'),
      ('ticket_fulfillment_operator_escalations', 'case_supplier_escalations_created_at_not_null', 'fulfillment_operator_escalations_created_at_not_null')
    ) AS names(table_name, old_name, new_name)
  LOOP
    IF EXISTS (
      SELECT 1
      FROM pg_constraint
      WHERE conrelid = item.table_name::regclass
        AND conname = item.old_name
    ) THEN
      EXECUTE format(
        'ALTER TABLE %I RENAME CONSTRAINT %I TO %I',
        item.table_name,
        item.old_name,
        item.new_name
      );
    END IF;
  END LOOP;
END $$;

ALTER INDEX "suppliers_tenant_email_unique" RENAME TO "fulfillment_operators_tenant_email_unique";
ALTER INDEX "suppliers_tenant_user_unique" RENAME TO "fulfillment_operators_tenant_user_unique";
ALTER INDEX "suppliers_user_idx" RENAME TO "fulfillment_operators_user_idx";
ALTER INDEX "suppliers_tenant_idx" RENAME TO "fulfillment_operators_tenant_idx";
ALTER INDEX "tse_supplier_status_idx" RENAME TO "fulfillment_operator_escalations_operator_status_idx";
ALTER INDEX "tse_ticket_idx" RENAME TO "fulfillment_operator_escalations_ticket_idx";
ALTER INDEX "tse_tenant_idx" RENAME TO "fulfillment_operator_escalations_tenant_idx";
ALTER INDEX "tse_unsent_idx" RENAME TO "fulfillment_operator_escalations_unsent_idx";

-- Persisted ticket and attachment state.
ALTER TABLE "tickets" DROP CONSTRAINT "tickets_status_check";
UPDATE "tickets"
SET "status" = 'waiting_for_fulfillment_operator'
WHERE "status" = 'waiting_for_supplier';
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_status_check" CHECK (
  "status" IN (
    'new',
    'triaging',
    'in_progress',
    'waiting_for_customer',
    'waiting_for_fulfillment_operator',
    'waiting_for_approval',
    'approved_action_running',
    'resolved',
    'archived',
    'failed',
    'human_takeover'
  )
);

UPDATE "ticket_state_transitions"
SET
  "from_status" = CASE
    WHEN "from_status" = 'waiting_for_supplier' THEN 'waiting_for_fulfillment_operator'
    ELSE "from_status"
  END,
  "to_status" = CASE
    WHEN "to_status" = 'waiting_for_supplier' THEN 'waiting_for_fulfillment_operator'
    ELSE "to_status"
  END,
  "reason" = replace(
    replace("reason", 'waiting_for_supplier', 'waiting_for_fulfillment_operator'),
    'supplier_unreachable',
    'fulfillment_operator_unreachable'
  )
WHERE "from_status" = 'waiting_for_supplier'
   OR "to_status" = 'waiting_for_supplier'
   OR "reason" LIKE '%waiting_for_supplier%'
   OR "reason" LIKE '%supplier_unreachable%';

ALTER TABLE "ticket_attachments" DROP CONSTRAINT "ticket_attachments_source_check";
UPDATE "ticket_attachments"
SET "source" = 'fulfillment_operator'
WHERE "source" = 'supplier';
ALTER TABLE "ticket_attachments" ADD CONSTRAINT "ticket_attachments_source_check"
  CHECK ("source" IN ('inbound', 'fulfillment_operator', 'merchant'));

-- Rename the constrained portal role itself. A pre-existing custom role with
-- the target display name is preserved under a deterministic custom label so
-- the constrained role can take the canonical merchant-facing name without
-- violating the per-workspace unique index.
UPDATE "roles" AS custom_role
SET
  "name" = 'Fulfillment partner (custom ' || custom_role."id"::text || ')',
  "updated_at" = now()
WHERE lower(custom_role."name") = 'fulfillment partner'
  AND EXISTS (
    SELECT 1
    FROM "roles" AS constrained_role
    WHERE constrained_role."tenant_id" = custom_role."tenant_id"
      AND lower(constrained_role."name") = 'supplier'
      AND constrained_role."is_owner" = false
      AND EXISTS (
        SELECT 1
        FROM "role_permissions"
        WHERE "role_permissions"."role_id" = constrained_role."id"
          AND "role_permissions"."permission_id" = 'supplier.tickets.view'
      )
      AND EXISTS (
        SELECT 1
        FROM "role_permissions"
        WHERE "role_permissions"."role_id" = constrained_role."id"
          AND "role_permissions"."permission_id" = 'supplier.tickets.respond'
      )
  );

UPDATE "roles" AS constrained_role
SET "name" = 'Fulfillment partner', "updated_at" = now()
WHERE lower(constrained_role."name") = 'supplier'
  AND constrained_role."is_owner" = false
  AND EXISTS (
    SELECT 1
    FROM "role_permissions"
    WHERE "role_permissions"."role_id" = constrained_role."id"
      AND "role_permissions"."permission_id" = 'supplier.tickets.view'
  )
  AND EXISTS (
    SELECT 1
    FROM "role_permissions"
    WHERE "role_permissions"."role_id" = constrained_role."id"
      AND "role_permissions"."permission_id" = 'supplier.tickets.respond'
  );

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT
  "role_id",
  CASE "permission_id"
    WHEN 'supplier.tickets.view' THEN 'fulfillment_operator.tickets.view'
    WHEN 'supplier.tickets.respond' THEN 'fulfillment_operator.tickets.respond'
  END
FROM "role_permissions"
WHERE "permission_id" IN ('supplier.tickets.view', 'supplier.tickets.respond')
ON CONFLICT DO NOTHING;

DELETE FROM "role_permissions"
WHERE "permission_id" IN ('supplier.tickets.view', 'supplier.tickets.respond');

-- Persisted workflow/tool identities.
UPDATE "approvals"
SET
  "tool" = replace("tool", 'supplier.', 'fulfillment_operator.'),
  "decision_reason" = CASE "decision_reason"
    WHEN 'superseded by supplier update' THEN 'superseded by fulfillment operator update'
    ELSE "decision_reason"
  END
WHERE "tool" LIKE 'supplier.%'
   OR "decision_reason" = 'superseded by supplier update';

UPDATE "tool_executions"
SET
  "tool" = replace("tool", 'supplier.', 'fulfillment_operator.'),
  "call_id" = replace(
    replace(
      replace("call_id", 'supplier.escalate:', 'fulfillment_operator.escalate:'),
      'supplier.add_sheet_row:',
      'fulfillment_operator.add_sheet_row:'
    ),
    'supplier-escalate:',
    'fulfillment-operator-escalate:'
  )
WHERE "tool" LIKE 'supplier.%'
   OR "call_id" LIKE '%supplier.escalate:%'
   OR "call_id" LIKE '%supplier.add_sheet_row:%'
   OR "call_id" LIKE '%supplier-escalate:%';

UPDATE "processed_events"
SET "event_type" = 'fulfillment_operator.updated'
WHERE "event_type" = 'supplier.updated';

-- Recursively rename only exact structured identities and known JSON keys.
-- Free text such as a customer mentioning "supplier.com" or a merchant's
-- sourcing supplier remains byte-for-byte unchanged.
CREATE FUNCTION pg_temp.migrate_fulfillment_operator_json(
  input jsonb,
  parent_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  item record;
  output jsonb;
  mapped_key text;
  scalar text;
BEGIN
  CASE jsonb_typeof(input)
    WHEN 'object' THEN
      output := '{}'::jsonb;
      FOR item IN SELECT * FROM jsonb_each(input)
      LOOP
        mapped_key := CASE item.key
          WHEN 'supplierId' THEN 'fulfillmentOperatorId'
          WHEN 'supplierUpdate' THEN 'fulfillmentOperatorUpdate'
          ELSE item.key
        END;
        output := output || jsonb_build_object(
          mapped_key,
          pg_temp.migrate_fulfillment_operator_json(item.value, mapped_key)
        );
      END LOOP;
      RETURN output;
    WHEN 'array' THEN
      SELECT coalesce(
        jsonb_agg(
          pg_temp.migrate_fulfillment_operator_json(element.value, parent_key)
          ORDER BY element.ordinality
        ),
        '[]'::jsonb
      )
      INTO output
      FROM jsonb_array_elements(input) WITH ORDINALITY AS element(value, ordinality);
      RETURN output;
    WHEN 'string' THEN
      scalar := input #>> '{}';
      IF parent_key = 'callId' THEN
        RETURN to_jsonb(replace(
          replace(
            replace(scalar, 'supplier.escalate:', 'fulfillment_operator.escalate:'),
            'supplier.add_sheet_row:',
            'fulfillment_operator.add_sheet_row:'
          ),
          'supplier-escalate:',
          'fulfillment-operator-escalate:'
        ));
      END IF;
      IF parent_key IS NULL OR parent_key NOT IN (
        'tool',
        'eventType',
        'status',
        'fromStatus',
        'toStatus',
        'riskFlag',
        'riskFlags',
        'reason',
        'source',
        'type',
        'action',
        'actorId'
      ) THEN
        RETURN input;
      END IF;
      RETURN to_jsonb(CASE scalar
        WHEN 'supplier.updated' THEN 'fulfillment_operator.updated'
        WHEN 'supplier.tracking_updated' THEN 'fulfillment_operator.tracking_updated'
        WHEN 'supplier.escalate' THEN 'fulfillment_operator.escalate'
        WHEN 'supplier.add_sheet_row' THEN 'fulfillment_operator.add_sheet_row'
        WHEN 'supplier.read_sheet_columns' THEN 'fulfillment_operator.read_sheet_columns'
        WHEN 'supplier.notify' THEN 'fulfillment_operator.notify'
        WHEN 'waiting_for_supplier' THEN 'waiting_for_fulfillment_operator'
        WHEN 'supplier_unreachable' THEN 'fulfillment_operator_unreachable'
        WHEN 'scenario_supplier_disabled' THEN 'scenario_fulfillment_operator_disabled'
        WHEN 'no_supplier' THEN 'no_fulfillment_operator'
        WHEN 'supplier-notify' THEN 'fulfillment-operator-notify'
        WHEN 'supplier update' THEN 'fulfillment operator update'
        WHEN 'superseded by supplier update' THEN 'superseded by fulfillment operator update'
        WHEN 'escalated to supplier from dashboard' THEN 'escalated to fulfillment operator from dashboard'
        ELSE scalar
      END);
    ELSE
      RETURN input;
  END CASE;
END $$;

UPDATE "audit_log"
SET
  "action" = replace(
    replace("action", 'waiting_for_supplier', 'waiting_for_fulfillment_operator'),
    'supplier.',
    'fulfillment_operator.'
  ),
  "details" = pg_temp.migrate_fulfillment_operator_json("details")
WHERE "action" LIKE '%supplier%'
   OR "details"::text LIKE '%supplier%';

UPDATE "tickets"
SET "context" = pg_temp.migrate_fulfillment_operator_json("context")
WHERE "context"::text LIKE '%supplier%';

UPDATE "tenant_agent_overrides"
SET
  "system_prompt" = replace(
    replace(
      replace("system_prompt", 'supplier.escalate', 'fulfillment_operator.escalate'),
      'supplier.add_sheet_row',
      'fulfillment_operator.add_sheet_row'
    ),
    'supplier.read_sheet_columns',
    'fulfillment_operator.read_sheet_columns'
  ),
  "tool_permissions" = replace(
    replace(
      replace("tool_permissions"::text, 'supplier.escalate', 'fulfillment_operator.escalate'),
      'supplier.add_sheet_row',
      'fulfillment_operator.add_sheet_row'
    ),
    'supplier.read_sheet_columns',
    'fulfillment_operator.read_sheet_columns'
  )::jsonb
WHERE "system_prompt" LIKE '%supplier.%'
   OR "tool_permissions"::text LIKE '%supplier.%';

UPDATE "tenant_custom_agents"
SET
  "instructions" = replace(
    replace(
      replace("instructions", 'supplier.escalate', 'fulfillment_operator.escalate'),
      'supplier.add_sheet_row',
      'fulfillment_operator.add_sheet_row'
    ),
    'supplier.read_sheet_columns',
    'fulfillment_operator.read_sheet_columns'
  ),
  "tools" = replace(
    replace(
      replace("tools"::text, 'supplier.escalate', 'fulfillment_operator.escalate'),
      'supplier.add_sheet_row',
      'fulfillment_operator.add_sheet_row'
    ),
    'supplier.read_sheet_columns',
    'fulfillment_operator.read_sheet_columns'
  )::jsonb,
  "permission_overrides" = replace(
    replace(
      replace("permission_overrides"::text, 'supplier.escalate', 'fulfillment_operator.escalate'),
      'supplier.add_sheet_row',
      'fulfillment_operator.add_sheet_row'
    ),
    'supplier.read_sheet_columns',
    'fulfillment_operator.read_sheet_columns'
  )::jsonb
WHERE "instructions" LIKE '%supplier.%'
   OR "tools"::text LIKE '%supplier.%'
   OR "permission_overrides"::text LIKE '%supplier.%';

-- Rename structured tenant settings and trusted built-in playbook notes. Only
-- notes whose hashes match a version shipped by this repo are rewritten;
-- merchant-authored prose can still legitimately discuss product suppliers.
UPDATE "tenants"
SET "settings" = (
  CASE
    WHEN "settings" ? 'supplierEscalationSheet' THEN
      ("settings" - 'supplierEscalationSheet') || jsonb_build_object(
        'fulfillmentOperatorEscalationSheet',
        "settings" -> 'supplierEscalationSheet'
      )
    ELSE "settings"
  END
);

WITH scenario_rows AS (
  SELECT
    tenants.id,
    scenario.value,
    scenario.ordinality,
    CASE scenario.value ->> 'key'
      WHEN 'delivery_issue' THEN md5(scenario.value ->> 'notes') IN (
        '038f221b86cc9b507b197fac949254c4',
        'fdae9121d784802adc5ffed0299bc7e5',
        '69fc3549aba313b40d1e5131d9c9dbbe',
        '3f7fbe9e3f92a9efab34934283bed7f7',
        'fccb2753f1e76a69188dce6e7bd3b0fa',
        '27cc4a6f4e00527a59fb59f01d57c498',
        '552d154541e3e32c65ce4d973f13d7f0',
        '9dd33d49ac8bfc9301d9b58b28f86bfc'
      )
      WHEN 'damaged_product' THEN md5(scenario.value ->> 'notes') IN (
        '4a087deb48eb041db7679ef24f60100e',
        'd7e0753e6aeef4084345dca1be09620c',
        '76d3e90f445d7ad38c9dea60aaf5d255',
        '66640bb9cb51a499150bd5ba2661b236',
        'acceef9a3d61df8b561162ea7cb40763',
        '62db5955a524a257741ce72052933180',
        'e34a4bff486aa48a42541e43dcca2ff0'
      )
      WHEN 'wrong_item' THEN md5(scenario.value ->> 'notes') IN (
        '33f62cf0844733392f72593bce9300a3',
        '94c5b185adb247a5124ee858b30d5040',
        'b26ddb8e132addb85141cbef442f0f84',
        '6e07b55e71ea4e5264aad8a391099094'
      )
      WHEN 'shipping_address_update' THEN md5(scenario.value ->> 'notes') IN (
        '68fb3c1d7fb5df086c46f3ceeb9cf65b',
        '6790d9e60f788c87da57d6c051abed10',
        '6603f6021b5e476e9c6bc84ab7098258',
        '12da34aa7437f00571d8b2affb2ddb99'
      )
      ELSE false
    END AS rewrite_notes
  FROM "tenants"
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE
      WHEN jsonb_typeof("tenants"."settings" #> '{resolutionPolicy,scenarios}') = 'array'
        THEN "tenants"."settings" #> '{resolutionPolicy,scenarios}'
      ELSE '[]'::jsonb
    END
  ) WITH ORDINALITY AS scenario(value, ordinality)
),
rewritten AS (
  SELECT
    id,
    jsonb_agg(
      (
        CASE
          WHEN value ? 'supplierMode' THEN
            jsonb_set(
              value - 'supplierMode',
              '{fulfillmentOperatorMode}',
              value -> 'supplierMode',
              true
            )
          ELSE value
        END
      ) || (
        CASE
          WHEN rewrite_notes THEN jsonb_build_object(
            'notes',
            replace(
              replace(
                replace(
                  replace(value ->> 'notes', 'Suppliers', 'Fulfillment operators'),
                  'Supplier',
                  'Fulfillment operator'
                ),
                'suppliers',
                'fulfillment operators'
              ),
              'supplier',
              'fulfillment operator'
            )
          )
          ELSE '{}'::jsonb
        END
      )
      ORDER BY ordinality
    ) AS scenarios
  FROM scenario_rows
  GROUP BY id
)
UPDATE "tenants"
SET "settings" = jsonb_set(
  "tenants"."settings",
  '{resolutionPolicy,scenarios}',
  rewritten.scenarios,
  false
)
FROM rewritten
WHERE "tenants"."id" = rewritten.id;

UPDATE "tenants"
SET "settings" = replace(
  replace(
    replace("settings"::text, 'supplier.escalate', 'fulfillment_operator.escalate'),
    'supplier.add_sheet_row',
    'fulfillment_operator.add_sheet_row'
  ),
  'supplier.read_sheet_columns',
  'fulfillment_operator.read_sheet_columns'
)::jsonb
WHERE "settings"::text LIKE '%supplier.%';

-- Rename the notification queue and its relational dependants before the new
-- worker starts. The queue is non-partitioned, so its jobs live in pg-boss's
-- shared default partition and can safely change their partition key.
--
-- Pending workflow events are rewritten only at known machine-data paths.
-- Never cast and replace the whole job payload: it can contain customer text,
-- subjects, and filenames where "supplier" remains legitimate prose.
DO $$
BEGIN
  IF to_regclass('pgboss.queue') IS NOT NULL THEN
    EXECUTE $sql$
      INSERT INTO pgboss.queue (
        name,
        policy,
        retry_limit,
        retry_delay,
        retry_backoff,
        retry_delay_max,
        expire_seconds,
        retention_seconds,
        deletion_seconds,
        dead_letter,
        partition,
        table_name,
        deferred_count,
        queued_count,
        warning_queued,
        active_count,
        total_count,
        heartbeat_seconds,
        singletons_active,
        monitor_on,
        maintain_on,
        created_on,
        updated_on
      )
      SELECT
        'fulfillment_operator.notify',
        policy,
        retry_limit,
        retry_delay,
        retry_backoff,
        retry_delay_max,
        expire_seconds,
        retention_seconds,
        deletion_seconds,
        dead_letter,
        partition,
        table_name,
        deferred_count,
        queued_count,
        warning_queued,
        active_count,
        total_count,
        heartbeat_seconds,
        singletons_active,
        monitor_on,
        maintain_on,
        created_on,
        updated_on
      FROM pgboss.queue
      WHERE name = 'supplier.notify'
      ON CONFLICT (name) DO NOTHING
    $sql$;

    IF to_regclass('pgboss.schedule') IS NOT NULL THEN
      EXECUTE $sql$
        DELETE FROM pgboss.schedule AS old_schedule
        USING pgboss.schedule AS new_schedule
        WHERE old_schedule.name = 'supplier.notify'
          AND new_schedule.name = 'fulfillment_operator.notify'
          AND new_schedule.key = old_schedule.key
      $sql$;
      EXECUTE $sql$
        UPDATE pgboss.schedule
        SET name = 'fulfillment_operator.notify'
        WHERE name = 'supplier.notify'
      $sql$;
    END IF;

    IF to_regclass('pgboss.subscription') IS NOT NULL THEN
      EXECUTE $sql$
        DELETE FROM pgboss.subscription AS old_subscription
        USING pgboss.subscription AS new_subscription
        WHERE old_subscription.name = 'supplier.notify'
          AND new_subscription.name = 'fulfillment_operator.notify'
          AND new_subscription.event = old_subscription.event
      $sql$;
      EXECUTE $sql$
        UPDATE pgboss.subscription
        SET name = 'fulfillment_operator.notify'
        WHERE name = 'supplier.notify'
      $sql$;
    END IF;

    IF to_regclass('pgboss.job') IS NOT NULL THEN
      EXECUTE $sql$
        UPDATE pgboss.job
        SET
          name = CASE name
            WHEN 'supplier.notify' THEN 'fulfillment_operator.notify'
            ELSE name
          END,
          dead_letter = CASE dead_letter
            WHEN 'supplier.notify' THEN 'fulfillment_operator.notify'
            ELSE dead_letter
          END
        WHERE name = 'supplier.notify'
           OR dead_letter = 'supplier.notify'
      $sql$;
    END IF;

    IF to_regclass('pgboss.bam') IS NOT NULL THEN
      EXECUTE $sql$
        UPDATE pgboss.bam
        SET queue = 'fulfillment_operator.notify'
        WHERE queue = 'supplier.notify'
      $sql$;
    END IF;

    EXECUTE $sql$
      UPDATE pgboss.queue
      SET dead_letter = 'fulfillment_operator.notify'
      WHERE dead_letter = 'supplier.notify'
    $sql$;
    EXECUTE $sql$
      DELETE FROM pgboss.queue
      WHERE name = 'supplier.notify'
    $sql$;
  END IF;

  IF to_regclass('pgboss.job') IS NOT NULL THEN
    EXECUTE $sql$
      UPDATE pgboss.job
      SET data = jsonb_set(
        jsonb_set(
          data,
          '{event,type}',
          to_jsonb('fulfillment_operator.updated'::text),
          false
        ) #- '{event,payload,supplierId}',
        '{event,payload,fulfillmentOperatorId}',
        data #> '{event,payload,supplierId}',
        true
      )
      WHERE data #>> '{event,type}' = 'supplier.updated'
        AND data #> '{event,payload,supplierId}' IS NOT NULL
    $sql$;

    EXECUTE $sql$
      UPDATE pgboss.job
      SET data = jsonb_set(
        data,
        '{event,type}',
        to_jsonb('fulfillment_operator.updated'::text),
        false
      )
      WHERE data #>> '{event,type}' = 'supplier.updated'
    $sql$;
  END IF;
END $$;
