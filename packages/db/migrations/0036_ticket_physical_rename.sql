ALTER TABLE IF EXISTS "cases" RENAME TO "tickets";
--> statement-breakpoint
ALTER TABLE IF EXISTS "case_state_transitions" RENAME TO "ticket_state_transitions";
--> statement-breakpoint
ALTER TABLE IF EXISTS "case_message_ids" RENAME TO "ticket_message_ids";
--> statement-breakpoint
ALTER TABLE IF EXISTS "case_supplier_escalations" RENAME TO "ticket_supplier_escalations";
--> statement-breakpoint
ALTER TABLE IF EXISTS "approvals" RENAME COLUMN "case_id" TO "ticket_id";
--> statement-breakpoint
ALTER TABLE IF EXISTS "audit_log" RENAME COLUMN "case_id" TO "ticket_id";
--> statement-breakpoint
ALTER TABLE IF EXISTS "ticket_state_transitions" RENAME COLUMN "case_id" TO "ticket_id";
--> statement-breakpoint
ALTER TABLE IF EXISTS "timers" RENAME COLUMN "case_id" TO "ticket_id";
--> statement-breakpoint
ALTER TABLE IF EXISTS "image_hashes" RENAME COLUMN "case_id" TO "ticket_id";
--> statement-breakpoint
ALTER TABLE IF EXISTS "processed_messages" RENAME COLUMN "case_id" TO "ticket_id";
--> statement-breakpoint
ALTER TABLE IF EXISTS "tool_executions" RENAME COLUMN "case_id" TO "ticket_id";
--> statement-breakpoint
ALTER TABLE IF EXISTS "ticket_message_ids" RENAME COLUMN "case_id" TO "ticket_id";
--> statement-breakpoint
ALTER TABLE IF EXISTS "ticket_supplier_escalations" RENAME COLUMN "case_id" TO "ticket_id";
--> statement-breakpoint
ALTER TABLE IF EXISTS "reply_deliveries" RENAME COLUMN "case_id" TO "ticket_id";
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cases_tenant_id_tenants_id_fk') THEN
    ALTER TABLE "tickets" RENAME CONSTRAINT "cases_tenant_id_tenants_id_fk" TO "tickets_tenant_id_tenants_id_fk";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cases_channel_check') THEN
    ALTER TABLE "tickets" RENAME CONSTRAINT "cases_channel_check" TO "tickets_channel_check";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cases_priority_check') THEN
    ALTER TABLE "tickets" RENAME CONSTRAINT "cases_priority_check" TO "tickets_priority_check";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cases_status_check') THEN
    ALTER TABLE "tickets" RENAME CONSTRAINT "cases_status_check" TO "tickets_status_check";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cases_provider_check') THEN
    ALTER TABLE "tickets" RENAME CONSTRAINT "cases_provider_check" TO "tickets_provider_check";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'approvals_case_id_cases_id_fk') THEN
    ALTER TABLE "approvals" RENAME CONSTRAINT "approvals_case_id_cases_id_fk" TO "approvals_ticket_id_tickets_id_fk";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'case_state_transitions_case_id_cases_id_fk') THEN
    ALTER TABLE "ticket_state_transitions" RENAME CONSTRAINT "case_state_transitions_case_id_cases_id_fk" TO "ticket_state_transitions_ticket_id_tickets_id_fk";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'timers_case_id_cases_id_fk') THEN
    ALTER TABLE "timers" RENAME CONSTRAINT "timers_case_id_cases_id_fk" TO "timers_ticket_id_tickets_id_fk";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'image_hashes_case_id_cases_id_fk') THEN
    ALTER TABLE "image_hashes" RENAME CONSTRAINT "image_hashes_case_id_cases_id_fk" TO "image_hashes_ticket_id_tickets_id_fk";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'processed_messages_case_id_cases_id_fk') THEN
    ALTER TABLE "processed_messages" RENAME CONSTRAINT "processed_messages_case_id_cases_id_fk" TO "processed_messages_ticket_id_tickets_id_fk";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_executions_case_id_cases_id_fk') THEN
    ALTER TABLE "tool_executions" RENAME CONSTRAINT "tool_executions_case_id_cases_id_fk" TO "tool_executions_ticket_id_tickets_id_fk";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'case_message_ids_tenant_id_tenants_id_fk') THEN
    ALTER TABLE "ticket_message_ids" RENAME CONSTRAINT "case_message_ids_tenant_id_tenants_id_fk" TO "ticket_message_ids_tenant_id_tenants_id_fk";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'case_message_ids_case_id_cases_id_fk') THEN
    ALTER TABLE "ticket_message_ids" RENAME CONSTRAINT "case_message_ids_case_id_cases_id_fk" TO "ticket_message_ids_ticket_id_tickets_id_fk";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'case_message_ids_direction_check') THEN
    ALTER TABLE "ticket_message_ids" RENAME CONSTRAINT "case_message_ids_direction_check" TO "ticket_message_ids_direction_check";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'case_supplier_escalations_tenant_id_tenants_id_fk') THEN
    ALTER TABLE "ticket_supplier_escalations" RENAME CONSTRAINT "case_supplier_escalations_tenant_id_tenants_id_fk" TO "ticket_supplier_escalations_tenant_id_tenants_id_fk";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'case_supplier_escalations_case_id_cases_id_fk') THEN
    ALTER TABLE "ticket_supplier_escalations" RENAME CONSTRAINT "case_supplier_escalations_case_id_cases_id_fk" TO "ticket_supplier_escalations_ticket_id_tickets_id_fk";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'case_supplier_escalations_supplier_id_suppliers_id_fk') THEN
    ALTER TABLE "ticket_supplier_escalations" RENAME CONSTRAINT "case_supplier_escalations_supplier_id_suppliers_id_fk" TO "ticket_supplier_escalations_supplier_id_suppliers_id_fk";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'case_supplier_escalations_status_check') THEN
    ALTER TABLE "ticket_supplier_escalations" RENAME CONSTRAINT "case_supplier_escalations_status_check" TO "ticket_supplier_escalations_status_check";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'reply_deliveries_case_id_cases_id_fk') THEN
    ALTER TABLE "reply_deliveries" RENAME CONSTRAINT "reply_deliveries_case_id_cases_id_fk" TO "reply_deliveries_ticket_id_tickets_id_fk";
  END IF;
END $$;
--> statement-breakpoint
ALTER INDEX IF EXISTS "cases_tenant_status_idx" RENAME TO "tickets_tenant_status_idx";
--> statement-breakpoint
ALTER INDEX IF EXISTS "cases_customer_idx" RENAME TO "tickets_customer_idx";
--> statement-breakpoint
ALTER INDEX IF EXISTS "cases_tenant_provider_mailbox_thread_unique" RENAME TO "tickets_tenant_provider_mailbox_thread_unique";
--> statement-breakpoint
ALTER INDEX IF EXISTS "cases_tenant_legacy_thread_unique" RENAME TO "tickets_tenant_legacy_thread_unique";
--> statement-breakpoint
ALTER INDEX IF EXISTS "cases_tenant_status_resolved_at_idx" RENAME TO "tickets_tenant_status_resolved_at_idx";
--> statement-breakpoint
ALTER INDEX IF EXISTS "cases_tenant_status_archived_at_idx" RENAME TO "tickets_tenant_status_archived_at_idx";
--> statement-breakpoint
ALTER INDEX IF EXISTS "case_message_ids_tenant_message_unique" RENAME TO "ticket_message_ids_tenant_message_unique";
--> statement-breakpoint
ALTER INDEX IF EXISTS "case_message_ids_case_idx" RENAME TO "ticket_message_ids_ticket_idx";
--> statement-breakpoint
ALTER INDEX IF EXISTS "cst_case_idx" RENAME TO "ticket_state_transitions_ticket_idx";
--> statement-breakpoint
ALTER INDEX IF EXISTS "audit_log_case_idx" RENAME TO "audit_log_ticket_idx";
--> statement-breakpoint
ALTER INDEX IF EXISTS "approvals_case_idx" RENAME TO "approvals_ticket_idx";
--> statement-breakpoint
ALTER INDEX IF EXISTS "timers_case_idx" RENAME TO "timers_ticket_idx";
--> statement-breakpoint
ALTER INDEX IF EXISTS "tool_executions_case_call_unique" RENAME TO "tool_executions_ticket_call_unique";
--> statement-breakpoint
ALTER INDEX IF EXISTS "image_hashes_case_idx" RENAME TO "image_hashes_ticket_idx";
--> statement-breakpoint
ALTER INDEX IF EXISTS "cse_supplier_status_idx" RENAME TO "tse_supplier_status_idx";
--> statement-breakpoint
ALTER INDEX IF EXISTS "cse_case_idx" RENAME TO "tse_ticket_idx";
--> statement-breakpoint
ALTER INDEX IF EXISTS "cse_tenant_idx" RENAME TO "tse_tenant_idx";
--> statement-breakpoint
ALTER INDEX IF EXISTS "cse_unsent_idx" RENAME TO "tse_unsent_idx";
--> statement-breakpoint
ALTER INDEX IF EXISTS "reply_deliveries_case_idx" RENAME TO "reply_deliveries_ticket_idx";
--> statement-breakpoint
ALTER INDEX IF EXISTS "reply_deliveries_case_draft_pending_unique" RENAME TO "reply_deliveries_ticket_draft_pending_unique";
