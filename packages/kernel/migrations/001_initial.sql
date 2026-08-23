-- ParallelPlay 0.1.0 fresh database schema. No predecessor migrations are supported.

CREATE TABLE advisor_audits_projection (
  audit_id TEXT PRIMARY KEY,
  resolution_id TEXT NOT NULL UNIQUE,
  policy_revision_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'completed')),
  due_at TEXT NOT NULL,
  state_json TEXT NOT NULL CHECK (json_valid(state_json)),
  digest TEXT NOT NULL CHECK (length(digest) = 64),
  version INTEGER NOT NULL CHECK (version > 0)
) STRICT;

CREATE TABLE advisor_cases_projection (
  case_id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL,
  source_family TEXT NOT NULL,
  provenance TEXT NOT NULL CHECK (provenance IN ('natural', 'synthetic', 'fixture')),
  state_json TEXT NOT NULL CHECK (json_valid(state_json)),
  digest TEXT NOT NULL CHECK (length(digest) = 64),
  version INTEGER NOT NULL CHECK (version > 0)
) STRICT;

CREATE TABLE advisor_contamination_projection (
  contamination_id TEXT PRIMARY KEY,
  corpus_revision_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  partition_name TEXT NOT NULL CHECK (partition_name IN ('calibration', 'holdout')),
  state_json TEXT NOT NULL CHECK (json_valid(state_json)),
  digest TEXT NOT NULL CHECK (length(digest) = 64),
  version INTEGER NOT NULL CHECK (version > 0)
) STRICT;

CREATE TABLE advisor_corpora_projection (
  corpus_revision_id TEXT PRIMARY KEY,
  corpus_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  state_json TEXT NOT NULL CHECK (json_valid(state_json)),
  digest TEXT NOT NULL CHECK (length(digest) = 64),
  superseded_at TEXT,
  version INTEGER NOT NULL CHECK (version > 0),
  UNIQUE (corpus_id, revision)
) STRICT;

CREATE TABLE advisor_evaluations_projection (
  report_id TEXT PRIMARY KEY,
  policy_revision_id TEXT NOT NULL,
  promotion_eligible INTEGER NOT NULL CHECK (promotion_eligible IN (0, 1)),
  state_json TEXT NOT NULL CHECK (json_valid(state_json)),
  digest TEXT NOT NULL CHECK (length(digest) = 64),
  version INTEGER NOT NULL CHECK (version > 0)
) STRICT;

CREATE TABLE advisor_incidents_projection (
  incident_id TEXT PRIMARY KEY,
  policy_revision_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'resolved')),
  state_json TEXT NOT NULL CHECK (json_valid(state_json)),
  digest TEXT NOT NULL CHECK (length(digest) = 64),
  version INTEGER NOT NULL CHECK (version > 0)
) STRICT;

CREATE TABLE advisor_invocations_projection (
  invocation_id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('pending', 'leased', 'succeeded', 'failed', 'cancelled')),
  available_at TEXT NOT NULL,
  state_json TEXT NOT NULL CHECK (json_valid(state_json)),
  digest TEXT NOT NULL CHECK (length(digest) = 64),
  version INTEGER NOT NULL CHECK (version > 0)
) STRICT;

CREATE TABLE advisor_recommendations_projection (
  recommendation_id TEXT PRIMARY KEY,
  invocation_id TEXT NOT NULL UNIQUE,
  subject_id TEXT NOT NULL,
  program_id TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('calibration', 'holdout', 'shadow', 'promoted')),
  state_json TEXT NOT NULL CHECK (json_valid(state_json)),
  digest TEXT NOT NULL CHECK (length(digest) = 64),
  version INTEGER NOT NULL CHECK (version > 0)
) STRICT;

CREATE TABLE advisor_resolutions_projection (
  resolution_id TEXT PRIMARY KEY,
  policy_revision_id TEXT NOT NULL,
  program_id TEXT NOT NULL,
  state_json TEXT NOT NULL CHECK (json_valid(state_json)),
  digest TEXT NOT NULL CHECK (length(digest) = 64),
  version INTEGER NOT NULL CHECK (version > 0)
) STRICT;

CREATE TABLE advisor_subjects_projection (
  subject_id TEXT PRIMARY KEY,
  state_json TEXT NOT NULL CHECK (json_valid(state_json)),
  digest TEXT NOT NULL CHECK (length(digest) = 64),
  version INTEGER NOT NULL CHECK (version > 0)
) STRICT;

CREATE TABLE approval_requests_projection (
  approval_request_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs_projection(run_id),
  job_id TEXT NOT NULL REFERENCES jobs_projection(job_id),
  attempt_id TEXT NOT NULL,
  capability TEXT NOT NULL,
  reason TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  requested_at TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  UNIQUE (attempt_id, sequence)
) STRICT;

CREATE TABLE artifact_manifests_projection (
  artifact_manifest_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs_projection(run_id),
  job_id TEXT NOT NULL REFERENCES jobs_projection(job_id),
  attempt_id TEXT NOT NULL,
  source_revision_id TEXT NOT NULL REFERENCES source_revisions_projection(revision_id),
  entries_json TEXT NOT NULL CHECK (json_valid(entries_json)),
  manifest_digest TEXT NOT NULL CHECK (length(manifest_digest) = 64),
  total_bytes INTEGER NOT NULL CHECK (total_bytes >= 0),
  created_at TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0)
, producer TEXT NOT NULL DEFAULT 'verifier'
  CHECK (producer IN ('agent', 'verifier'))) STRICT;

CREATE TABLE "attempts_projection" (
  attempt_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs_projection(run_id),
  job_id TEXT,
  ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  status TEXT NOT NULL CHECK (status IN (
    'allocated', 'starting', 'running', 'verifying', 'succeeded', 'failed',
    'timed_out', 'cancelled', 'approval_required'
  )),
  allocated_at TEXT NOT NULL,
  started_at TEXT,
  deadline_at TEXT,
  external_run_id TEXT,
  driver_cursor INTEGER NOT NULL DEFAULT 0 CHECK (driver_cursor >= 0),
  cumulative_usage_json TEXT CHECK (
    cumulative_usage_json IS NULL OR json_valid(cumulative_usage_json)
  ),
  candidate_revision_id TEXT,
  driver_receipt_id TEXT,
  finished_at TEXT,
  cancelled_at TEXT,
  cancellation_reason TEXT,
  termination_reason TEXT CHECK (
    termination_reason IS NULL OR termination_reason IN (
      'completed', 'driver_error', 'timed_out', 'operator_cancelled', 'run_failed',
      'verification_failed', 'verification_invalid', 'approval_required',
      'protocol_invalid', 'capability_violation'
    )
  ),
  version INTEGER NOT NULL CHECK (version > 0),
  UNIQUE (job_id, ordinal)
) STRICT;

CREATE TABLE attention_budget_incidents_projection (
  incident_id TEXT PRIMARY KEY,
  packet_id TEXT NOT NULL,
  program_id TEXT NOT NULL REFERENCES programs_projection(program_id),
  state_json TEXT NOT NULL CHECK (json_valid(state_json)),
  digest TEXT NOT NULL CHECK (length(digest) = 64),
  version INTEGER NOT NULL CHECK (version > 0)
) STRICT;

CREATE TABLE attention_deliveries_projection (
  delivery_id TEXT PRIMARY KEY,
  packet_id TEXT NOT NULL,
  program_id TEXT NOT NULL REFERENCES programs_projection(program_id),
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'leased', 'delivered', 'obsolete', 'permanent_failure')
  ),
  available_at TEXT NOT NULL,
  state_json TEXT NOT NULL CHECK (json_valid(state_json)),
  version INTEGER NOT NULL CHECK (version > 0)
) STRICT;

CREATE TABLE attention_digest_artifacts_projection (
  artifact_id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL REFERENCES programs_projection(program_id),
  state_json TEXT NOT NULL CHECK (json_valid(state_json)),
  digest TEXT NOT NULL CHECK (length(digest) = 64),
  version INTEGER NOT NULL CHECK (version > 0)
) STRICT;

CREATE TABLE attention_measurement_reports_projection (
  report_id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL REFERENCES programs_projection(program_id),
  state_json TEXT NOT NULL CHECK (json_valid(state_json)),
  digest TEXT NOT NULL CHECK (length(digest) = 64),
  version INTEGER NOT NULL CHECK (version > 0)
) STRICT;

CREATE TABLE attention_policies_projection (
  policy_revision_id TEXT PRIMARY KEY,
  policy_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  state_json TEXT NOT NULL CHECK (json_valid(state_json)),
  digest TEXT NOT NULL CHECK (length(digest) = 64),
  superseded_at TEXT,
  version INTEGER NOT NULL CHECK (version > 0),
  UNIQUE (policy_id, revision)
) STRICT;

CREATE TABLE attention_spans_projection (
  attention_span_id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL REFERENCES programs_projection(program_id),
  actor_id TEXT NOT NULL,
  label TEXT NOT NULL,
  started_at TEXT NOT NULL,
  stopped_at TEXT,
  version INTEGER NOT NULL CHECK (version > 0)
) STRICT;

CREATE TABLE candidate_diff_manifests_projection (
  manifest_id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL REFERENCES programs_projection(program_id),
  candidate_revision_id TEXT NOT NULL,
  eligible INTEGER NOT NULL CHECK (eligible IN (0, 1)),
  state_json TEXT NOT NULL CHECK (json_valid(state_json)),
  digest TEXT NOT NULL CHECK (length(digest) = 64),
  version INTEGER NOT NULL CHECK (version > 0),
  UNIQUE (candidate_revision_id)
) STRICT;

CREATE TABLE command_receipts (
  command_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  command_type TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('accepted', 'rejected')),
  result_json TEXT NOT NULL CHECK (json_valid(result_json)),
  recorded_at TEXT NOT NULL
) STRICT;

CREATE TABLE concurrency_leases_projection (
  lease_id TEXT PRIMARY KEY,
  admission_id TEXT NOT NULL,
  program_id TEXT NOT NULL REFERENCES programs_projection(program_id),
  claim_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'released', 'fenced')),
  expires_at TEXT NOT NULL,
  fencing_token INTEGER NOT NULL CHECK (fencing_token > 0),
  state_json TEXT NOT NULL CHECK (json_valid(state_json)),
  digest TEXT NOT NULL CHECK (length(digest) = 64),
  version INTEGER NOT NULL CHECK (version > 0),
  UNIQUE (claim_key, fencing_token)
) STRICT;

CREATE TABLE context_packets_projection (
  context_packet_id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL REFERENCES programs_projection(program_id),
  milestone_id TEXT NOT NULL REFERENCES milestones_projection(milestone_id),
  generation_id TEXT NOT NULL,
  packet_json TEXT NOT NULL CHECK (json_valid(packet_json)),
  packet_digest TEXT NOT NULL CHECK (length(packet_digest) = 64),
  compiled_at TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  UNIQUE (generation_id)
) STRICT;

CREATE TABLE decision_acknowledgements_projection (
  acknowledgement_id TEXT PRIMARY KEY,
  packet_id TEXT NOT NULL,
  program_id TEXT NOT NULL REFERENCES programs_projection(program_id),
  state_json TEXT NOT NULL CHECK (json_valid(state_json)),
  digest TEXT NOT NULL CHECK (length(digest) = 64),
  version INTEGER NOT NULL CHECK (version > 0)
) STRICT;

CREATE TABLE decision_action_results_projection (
  action_result_id TEXT PRIMARY KEY,
  packet_id TEXT NOT NULL UNIQUE,
  program_id TEXT NOT NULL REFERENCES programs_projection(program_id),
  state_json TEXT NOT NULL CHECK (json_valid(state_json)),
  digest TEXT NOT NULL CHECK (length(digest) = 64),
  version INTEGER NOT NULL CHECK (version > 0)
) STRICT;

CREATE TABLE decision_evidence_bundles_projection (
  evidence_bundle_id TEXT PRIMARY KEY,
  packet_id TEXT NOT NULL,
  program_id TEXT NOT NULL REFERENCES programs_projection(program_id),
  state_json TEXT NOT NULL CHECK (json_valid(state_json)),
  digest TEXT NOT NULL CHECK (length(digest) = 64),
  version INTEGER NOT NULL CHECK (version > 0)
) STRICT;

CREATE TABLE decision_packet_revisions_projection (
  packet_revision_id TEXT PRIMARY KEY,
  packet_id TEXT NOT NULL,
  program_id TEXT NOT NULL REFERENCES programs_projection(program_id),
  revision INTEGER NOT NULL CHECK (revision > 0),
  state_json TEXT NOT NULL CHECK (json_valid(state_json)),
  digest TEXT NOT NULL CHECK (length(digest) = 64),
  version INTEGER NOT NULL CHECK (version > 0),
  UNIQUE (packet_id, revision)
) STRICT;

CREATE TABLE decision_packets_projection (
  packet_id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL REFERENCES programs_projection(program_id),
  current_revision_id TEXT NOT NULL,
  current_revision_digest TEXT NOT NULL CHECK (length(current_revision_digest) = 64),
  status TEXT NOT NULL CHECK (status IN ('open', 'resolved', 'expired')),
  state_json TEXT NOT NULL CHECK (json_valid(state_json)),
  version INTEGER NOT NULL CHECK (version > 0)
) STRICT;

CREATE TABLE decision_policies_projection (
  policy_revision_id TEXT PRIMARY KEY,
  policy_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  status TEXT NOT NULL CHECK (status IN ('shadow', 'active', 'suspended', 'expired', 'superseded')),
  state_json TEXT NOT NULL CHECK (json_valid(state_json)),
  digest TEXT NOT NULL CHECK (length(digest) = 64),
  version INTEGER NOT NULL CHECK (version > 0),
  UNIQUE (policy_id, revision)
) STRICT;

CREATE TABLE decision_policy_promotions_projection (
  promotion_id TEXT PRIMARY KEY,
  policy_revision_id TEXT NOT NULL,
  state_json TEXT NOT NULL CHECK (json_valid(state_json)),
  digest TEXT NOT NULL CHECK (length(digest) = 64),
  version INTEGER NOT NULL CHECK (version > 0)
) STRICT;

CREATE TABLE decision_policy_proposals_projection (
  proposal_id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('open', 'dismissed', 'approved', 'superseded')),
  state_json TEXT NOT NULL CHECK (json_valid(state_json)),
  digest TEXT NOT NULL CHECK (length(digest) = 64),
  version INTEGER NOT NULL CHECK (version > 0)
) STRICT;

CREATE TABLE decision_precedents_projection (
  precedent_id TEXT PRIMARY KEY,
  packet_id TEXT NOT NULL UNIQUE,
  program_id TEXT NOT NULL REFERENCES programs_projection(program_id),
  state_json TEXT NOT NULL CHECK (json_valid(state_json)),
  digest TEXT NOT NULL CHECK (length(digest) = 64),
  version INTEGER NOT NULL CHECK (version > 0)
) STRICT;

CREATE TABLE decision_resolutions_projection (
  resolution_id TEXT PRIMARY KEY,
  packet_id TEXT NOT NULL UNIQUE,
  program_id TEXT NOT NULL REFERENCES programs_projection(program_id),
  state_json TEXT NOT NULL CHECK (json_valid(state_json)),
  digest TEXT NOT NULL CHECK (length(digest) = 64),
  version INTEGER NOT NULL CHECK (version > 0)
) STRICT;

CREATE TABLE driver_receipts_projection (
  driver_receipt_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs_projection(run_id),
  job_id TEXT NOT NULL REFERENCES jobs_projection(job_id),
  attempt_id TEXT NOT NULL,
  external_run_id TEXT NOT NULL,
  base_revision_id TEXT NOT NULL REFERENCES source_revisions_projection(revision_id),
  candidate_revision_id TEXT REFERENCES source_revisions_projection(revision_id),
  outcome TEXT NOT NULL CHECK (outcome IN (
    'succeeded', 'failed', 'approval_required', 'capability_violation',
    'protocol_invalid', 'operator_cancelled', 'timed_out'
  )),
  terminal_reason TEXT NOT NULL,
  receipt_json TEXT NOT NULL CHECK (json_valid(receipt_json)),
  receipt_digest TEXT NOT NULL CHECK (length(receipt_digest) = 64),
  recorded_at TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  UNIQUE (attempt_id)
) STRICT;

CREATE TABLE events (
  global_position INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  command_id TEXT NOT NULL,
  stream_type TEXT NOT NULL CHECK (stream_type IN (
    'program', 'milestone', 'milestone_generation', 'program_interview', 'program_graph',
    'context_packet', 'outcome_validation', 'routed_issue', 'attention_span',
    'outcome_disposition', 'measurement_report', 'outcome_packet', 'workflow', 'run',
    'attempt', 'job', 'outbox', 'source_revision', 'artifact_manifest', 'verification',
    'driver_receipt', 'approval_request', 'operator_decision_request', 'decision_packet',
    'decision_packet_revision', 'decision_evidence_bundle', 'attention_policy',
    'decision_acknowledgement', 'decision_resolution', 'decision_action_result',
    'decision_precedent', 'attention_delivery', 'attention_budget_incident',
    'attention_measurement_report', 'attention_digest_artifact', 'portfolio_policy',
    'integration_target', 'portfolio_admission', 'concurrency_lease',
    'candidate_diff_manifest', 'integration_candidate', 'integration_work',
    'integration_conflict', 'promotion_receipt', 'portfolio_slo_incident',
    'portfolio_measurement_report', 'advisor_subject', 'advisor_case', 'advisor_corpus',
    'advisor_contamination', 'advisor_invocation', 'advisor_recommendation',
    'advisor_evaluation', 'decision_policy_proposal', 'decision_policy',
    'decision_policy_promotion', 'advisor_resolution', 'advisor_audit', 'advisor_incident'
  )),
  stream_id TEXT NOT NULL,
  stream_version INTEGER NOT NULL CHECK (stream_version > 0),
  event_type TEXT NOT NULL,
  event_schema_version INTEGER NOT NULL CHECK (event_schema_version > 0),
  data_json TEXT NOT NULL CHECK (json_valid(data_json)),
  metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json)),
  occurred_at TEXT NOT NULL,
  UNIQUE (stream_type, stream_id, stream_version)
) STRICT;

CREATE TABLE outbound_authority_events (
  global_position INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'policy.promoted', 'policy.suspended', 'effect.authorized',
    'effect.receipt-recorded', 'effect.failed'
  )),
  stream_id TEXT NOT NULL,
  data_json TEXT NOT NULL CHECK (json_valid(data_json)),
  occurred_at TEXT NOT NULL
) STRICT;

CREATE TABLE integration_candidates_projection (
  candidate_id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL REFERENCES programs_projection(program_id),
  target_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'pending', 'blocked', 'preparing', 'conflicted', 'verifying',
    'awaiting_authorization', 'authorized', 'promoting', 'promoted', 'ineligible'
  )),
  admission_sequence INTEGER NOT NULL CHECK (admission_sequence > 0),
  state_json TEXT NOT NULL CHECK (json_valid(state_json)),
  digest TEXT NOT NULL CHECK (length(digest) = 64),
  version INTEGER NOT NULL CHECK (version > 0)
) STRICT;

CREATE TABLE integration_conflicts_projection (
  conflict_id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL,
  state_json TEXT NOT NULL CHECK (json_valid(state_json)),
  digest TEXT NOT NULL CHECK (length(digest) = 64),
  version INTEGER NOT NULL CHECK (version > 0)
) STRICT;

CREATE TABLE integration_targets_projection (
  target_revision_id TEXT PRIMARY KEY,
  target_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  repository_id TEXT NOT NULL,
  state_json TEXT NOT NULL CHECK (json_valid(state_json)),
  digest TEXT NOT NULL CHECK (length(digest) = 64),
  superseded_at TEXT,
  version INTEGER NOT NULL CHECK (version > 0),
  UNIQUE (target_id, revision)
) STRICT;

CREATE TABLE integration_verifications_projection (
  integration_verification_id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL,
  state_json TEXT NOT NULL CHECK (json_valid(state_json)),
  digest TEXT NOT NULL CHECK (length(digest) = 64),
  version INTEGER NOT NULL CHECK (version > 0)
) STRICT;

CREATE TABLE integration_work_projection (
  work_id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN (
    'pending', 'leased', 'prepared', 'verified', 'authorized', 'promoted',
    'conflicted', 'failed', 'obsolete'
  )),
  available_at TEXT NOT NULL,
  state_json TEXT NOT NULL CHECK (json_valid(state_json)),
  digest TEXT NOT NULL CHECK (length(digest) = 64),
  version INTEGER NOT NULL CHECK (version > 0)
) STRICT;

CREATE TABLE job_dependencies_projection (
  job_id TEXT NOT NULL REFERENCES jobs_projection(job_id) ON DELETE CASCADE,
  depends_on_job_id TEXT NOT NULL REFERENCES jobs_projection(job_id) ON DELETE CASCADE,
  dependency_ordinal INTEGER NOT NULL CHECK (dependency_ordinal >= 0),
  PRIMARY KEY (job_id, depends_on_job_id),
  UNIQUE (job_id, dependency_ordinal),
  CHECK (job_id <> depends_on_job_id)
) STRICT;

CREATE TABLE jobs_projection (
  job_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs_projection(run_id),
  step_id TEXT NOT NULL,
  capability TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('blocked', 'ready', 'active', 'retry_wait', 'succeeded', 'failed', 'cancelled')),
  max_attempts INTEGER NOT NULL CHECK (max_attempts > 0),
  attempt_timeout_ms INTEGER NOT NULL CHECK (attempt_timeout_ms > 0),
  retry_delays_json TEXT NOT NULL CHECK (json_valid(retry_delays_json)),
  attempt_count INTEGER NOT NULL CHECK (attempt_count >= 0),
  active_attempt_id TEXT,
  available_at TEXT NOT NULL,
  lease_owner_id TEXT,
  lease_fencing_token INTEGER NOT NULL CHECK (lease_fencing_token >= 0),
  lease_acquired_at TEXT,
  lease_expires_at TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  failure_reason TEXT,
  version INTEGER NOT NULL CHECK (version > 0), source_revision_id TEXT, verifier_contract_json TEXT CHECK (
  verifier_contract_json IS NULL OR json_valid(verifier_contract_json)
), verifier_contract_digest TEXT CHECK (
  verifier_contract_digest IS NULL OR length(verifier_contract_digest) = 64
), execution_contract_json TEXT CHECK (
  execution_contract_json IS NULL OR json_valid(execution_contract_json)
), execution_contract_digest TEXT CHECK (
  execution_contract_digest IS NULL OR length(execution_contract_digest) = 64
), capability_manifest_json TEXT CHECK (
  capability_manifest_json IS NULL OR json_valid(capability_manifest_json)
), capability_manifest_digest TEXT CHECK (
  capability_manifest_digest IS NULL OR length(capability_manifest_digest) = 64
), candidate_revision_id TEXT, context_packet_id TEXT, context_packet_digest TEXT
  CHECK (context_packet_digest IS NULL OR length(context_packet_digest) = 64),
  UNIQUE (run_id, step_id)
) STRICT;

CREATE TABLE measurement_reports_projection (
  report_id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL REFERENCES programs_projection(program_id),
  report_json TEXT NOT NULL CHECK (json_valid(report_json)),
  report_digest TEXT NOT NULL CHECK (length(report_digest) = 64),
  compiled_at TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0)
) STRICT;

CREATE TABLE milestone_generations_projection (
  generation_id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL REFERENCES programs_projection(program_id),
  milestone_id TEXT NOT NULL REFERENCES milestones_projection(milestone_id),
  graph_revision_id TEXT NOT NULL REFERENCES program_graphs_projection(graph_revision_id),
  generation INTEGER NOT NULL CHECK (generation > 0),
  run_id TEXT NOT NULL UNIQUE REFERENCES runs_projection(run_id),
  job_id TEXT NOT NULL UNIQUE REFERENCES jobs_projection(job_id),
  context_packet_id TEXT NOT NULL UNIQUE,
  base_revision_id TEXT NOT NULL REFERENCES source_revisions_projection(revision_id),
  status TEXT NOT NULL CHECK (status IN ('running', 'outcome_ready', 'paused')),
  outcome_packet_id TEXT,
  recommendation TEXT CHECK (
    recommendation IS NULL OR recommendation IN ('merge', 'reject', 'investigate')
  ),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  version INTEGER NOT NULL CHECK (version > 0),
  UNIQUE (milestone_id, generation)
) STRICT;

CREATE TABLE milestones_projection (
  milestone_id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL REFERENCES programs_projection(program_id),
  graph_revision_id TEXT,
  contract_json TEXT NOT NULL CHECK (json_valid(contract_json)),
  contract_digest TEXT NOT NULL CHECK (length(contract_digest) = 64),
  workflow_digest TEXT NOT NULL CHECK (length(workflow_digest) = 64),
  dependencies_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(dependencies_json)),
  source_predecessor_milestone_id TEXT,
  allowed_work_surfaces_json TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(allowed_work_surfaces_json)),
  status TEXT NOT NULL CHECK (
    status IN ('approved', 'eligible', 'running', 'paused', 'outcome_ready')
  ),
  generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
  active_generation_id TEXT,
  run_id TEXT,
  job_id TEXT,
  base_revision_id TEXT,
  outcome_packet_id TEXT,
  latest_validated_outcome_packet_id TEXT,
  recommendation TEXT CHECK (
    recommendation IS NULL OR recommendation IN ('merge', 'reject', 'investigate')
  ),
  pause_reason TEXT,
  approved_by TEXT NOT NULL,
  approved_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  version INTEGER NOT NULL CHECK (version > 0), structured_work_surfaces_json TEXT
  CHECK (structured_work_surfaces_json IS NULL OR json_valid(structured_work_surfaces_json)), resource_claim_ids_json TEXT
  CHECK (resource_claim_ids_json IS NULL OR json_valid(resource_claim_ids_json)), capability_claims_json TEXT
  CHECK (capability_claims_json IS NULL OR json_valid(capability_claims_json)),
  UNIQUE (run_id),
  UNIQUE (job_id),
  UNIQUE (active_generation_id)
) STRICT;

CREATE TABLE operator_decision_requests_projection (
  request_id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL REFERENCES programs_projection(program_id),
  state_json TEXT NOT NULL CHECK (json_valid(state_json)),
  digest TEXT NOT NULL CHECK (length(digest) = 64),
  version INTEGER NOT NULL CHECK (version > 0)
) STRICT;

CREATE TABLE "outbox_projection" (
  outbox_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs_projection(run_id),
  job_id TEXT NOT NULL REFERENCES jobs_projection(job_id),
  attempt_id TEXT NOT NULL,
  effect_type TEXT NOT NULL CHECK (effect_type IN ('agent.start', 'agent.cancel', 'verification.run')),
  effect_key TEXT NOT NULL UNIQUE,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  status TEXT NOT NULL CHECK (status IN ('pending', 'leased', 'delivered', 'obsolete', 'dead_letter')),
  delivery_attempts INTEGER NOT NULL CHECK (delivery_attempts >= 0),
  retry_delays_json TEXT NOT NULL CHECK (json_valid(retry_delays_json)),
  available_at TEXT NOT NULL,
  lease_owner_id TEXT,
  lease_fencing_token INTEGER NOT NULL CHECK (lease_fencing_token >= 0),
  lease_acquired_at TEXT,
  lease_expires_at TEXT,
  external_effect_id TEXT,
  created_at TEXT NOT NULL,
  delivered_at TEXT,
  last_error TEXT,
  version INTEGER NOT NULL CHECK (version > 0)
) STRICT;

CREATE TABLE outcome_dispositions_projection (
  outcome_packet_id TEXT PRIMARY KEY REFERENCES outcome_packets_projection(outcome_packet_id),
  program_id TEXT NOT NULL REFERENCES programs_projection(program_id),
  disposition TEXT NOT NULL CHECK (disposition IN ('accepted', 'rejected')),
  reason TEXT,
  actor_id TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0)
) STRICT;

CREATE TABLE outcome_packets_projection (
  outcome_packet_id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL REFERENCES programs_projection(program_id),
  milestone_id TEXT NOT NULL REFERENCES milestones_projection(milestone_id),
  generation_id TEXT,
  generation INTEGER,
  run_id TEXT NOT NULL REFERENCES runs_projection(run_id),
  packet_json TEXT NOT NULL CHECK (json_valid(packet_json)),
  packet_digest TEXT NOT NULL CHECK (length(packet_digest) = 64),
  recorded_at TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  UNIQUE (run_id)
) STRICT;

CREATE TABLE outcome_validations_projection (
  validation_id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL REFERENCES programs_projection(program_id),
  milestone_id TEXT NOT NULL REFERENCES milestones_projection(milestone_id),
  outcome_packet_id TEXT NOT NULL REFERENCES outcome_packets_projection(outcome_packet_id),
  packet_digest TEXT NOT NULL CHECK (length(packet_digest) = 64),
  validation_json TEXT NOT NULL CHECK (json_valid(validation_json)),
  validation_digest TEXT NOT NULL CHECK (length(validation_digest) = 64),
  validated_at TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0)
) STRICT;

CREATE TABLE portfolio_admissions_projection (
  admission_id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL REFERENCES programs_projection(program_id),
  generation_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'released', 'fenced')),
  admission_sequence INTEGER NOT NULL CHECK (admission_sequence > 0),
  state_json TEXT NOT NULL CHECK (json_valid(state_json)),
  digest TEXT NOT NULL CHECK (length(digest) = 64),
  version INTEGER NOT NULL CHECK (version > 0)
) STRICT;

CREATE TABLE portfolio_measurement_reports_projection (
  report_id TEXT PRIMARY KEY,
  policy_revision_id TEXT NOT NULL,
  state_json TEXT NOT NULL CHECK (json_valid(state_json)),
  digest TEXT NOT NULL CHECK (length(digest) = 64),
  version INTEGER NOT NULL CHECK (version > 0)
) STRICT;

CREATE TABLE portfolio_policies_projection (
  policy_revision_id TEXT PRIMARY KEY,
  policy_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  state_json TEXT NOT NULL CHECK (json_valid(state_json)),
  digest TEXT NOT NULL CHECK (length(digest) = 64),
  superseded_at TEXT,
  version INTEGER NOT NULL CHECK (version > 0),
  UNIQUE (policy_id, revision)
) STRICT;

CREATE TABLE portfolio_slo_incidents_projection (
  incident_id TEXT PRIMARY KEY,
  policy_revision_id TEXT NOT NULL,
  incident_kind TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'resolved')),
  state_json TEXT NOT NULL CHECK (json_valid(state_json)),
  digest TEXT NOT NULL CHECK (length(digest) = 64),
  version INTEGER NOT NULL CHECK (version > 0)
) STRICT;

CREATE TABLE program_graphs_projection (
  graph_revision_id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL REFERENCES programs_projection(program_id),
  revision INTEGER NOT NULL CHECK (revision > 0),
  prior_graph_revision_id TEXT,
  graph_json TEXT NOT NULL CHECK (json_valid(graph_json)),
  graph_digest TEXT NOT NULL CHECK (length(graph_digest) = 64),
  approved_by TEXT NOT NULL,
  approved_at TEXT NOT NULL,
  superseded_at TEXT,
  version INTEGER NOT NULL CHECK (version > 0),
  UNIQUE (program_id, revision)
) STRICT;

CREATE TABLE program_interviews_projection (
  interview_id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL REFERENCES programs_projection(program_id),
  transcript_json TEXT NOT NULL CHECK (json_valid(transcript_json)),
  transcript_digest TEXT NOT NULL CHECK (length(transcript_digest) = 64),
  playback_id TEXT NOT NULL UNIQUE,
  playback_json TEXT NOT NULL CHECK (json_valid(playback_json)),
  playback_digest TEXT NOT NULL CHECK (length(playback_digest) = 64),
  captured_at TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0)
) STRICT;

CREATE TABLE programs_projection (
  program_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status = 'active'),
  created_at TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0)
, intent_json TEXT CHECK (
  intent_json IS NULL OR json_valid(intent_json)
), intent_digest TEXT CHECK (
  intent_digest IS NULL OR length(intent_digest) = 64
), approved_by TEXT, approved_at TEXT, program_mode TEXT NOT NULL DEFAULT 'legacy_v1'
  CHECK (program_mode IN ('legacy_v1', 'graph_v1')), phase TEXT NOT NULL DEFAULT 'legacy_active'
  CHECK (phase IN ('legacy_active', 'draft', 'approved', 'running', 'completed')), initial_source_revision_id TEXT, initial_source_revision_digest TEXT
  CHECK (initial_source_revision_digest IS NULL OR length(initial_source_revision_digest) = 64), active_graph_revision_id TEXT, active_graph_digest TEXT
  CHECK (active_graph_digest IS NULL OR length(active_graph_digest) = 64), started_at TEXT, attention_phase TEXT
  CHECK (attention_phase IS NULL OR attention_phase = 'parked'), attention_priority TEXT NOT NULL DEFAULT 'p2'
  CHECK (attention_priority IN ('p0', 'p1', 'p2', 'p3')), portfolio_mode TEXT
  CHECK (portfolio_mode IS NULL OR portfolio_mode = 'graph_v2'), portfolio_phase TEXT
  CHECK (portfolio_phase IS NULL OR portfolio_phase IN (
    'approved', 'eligible', 'running', 'integration_pending', 'completed'
  )), portfolio_resume_phase TEXT
  CHECK (portfolio_resume_phase IS NULL OR portfolio_resume_phase IN (
    'eligible', 'running', 'integration_pending'
  )), execution_requested_at TEXT, execution_request_id TEXT, execution_policy_json TEXT
  CHECK (execution_policy_json IS NULL OR json_valid(execution_policy_json))) STRICT;

CREATE TABLE projection_meta (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  last_applied_position INTEGER NOT NULL CHECK (last_applied_position >= 0)
) STRICT;

CREATE TABLE promotion_receipts_projection (
  receipt_id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL UNIQUE,
  program_id TEXT NOT NULL REFERENCES programs_projection(program_id),
  target_id TEXT NOT NULL,
  state_json TEXT NOT NULL CHECK (json_valid(state_json)),
  digest TEXT NOT NULL CHECK (length(digest) = 64),
  version INTEGER NOT NULL CHECK (version > 0)
) STRICT;

CREATE TABLE routed_issues_projection (
  issue_id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL REFERENCES programs_projection(program_id),
  issue_json TEXT NOT NULL CHECK (json_valid(issue_json)),
  issue_digest TEXT NOT NULL CHECK (length(issue_digest) = 64),
  status TEXT NOT NULL CHECK (status IN ('open', 'resolved', 'requires_graph_revision')),
  resolution_json TEXT CHECK (resolution_json IS NULL OR json_valid(resolution_json)),
  raised_at TEXT NOT NULL,
  resolved_at TEXT,
  version INTEGER NOT NULL CHECK (version > 0)
) STRICT;

CREATE TABLE "runs_projection" (
  run_id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL REFERENCES programs_projection(program_id),
  workflow_id TEXT NOT NULL,
  workflow_version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('created', 'scheduled', 'running', 'succeeded', 'failed', 'cancelled')),
  created_at TEXT NOT NULL,
  scheduled_at TEXT,
  started_at TEXT,
  completed_at TEXT,
  cancelled_at TEXT,
  cancellation_reason TEXT,
  failure_reason TEXT,
  version INTEGER NOT NULL CHECK (version > 0), milestone_id TEXT, generation_id TEXT, generation INTEGER CHECK (generation IS NULL OR generation > 0),
  FOREIGN KEY (workflow_id, workflow_version)
    REFERENCES workflows_projection(workflow_id, version)
) STRICT;

CREATE TABLE source_revisions_projection (
  revision_id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL,
  object_format TEXT NOT NULL CHECK (object_format IN ('sha1', 'sha256')),
  commit_oid TEXT NOT NULL,
  tree_oid TEXT NOT NULL,
  storage_ref TEXT NOT NULL,
  revision_digest TEXT NOT NULL CHECK (length(revision_digest) = 64),
  captured_at TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0)
) STRICT;

CREATE TABLE verifications_projection (
  verification_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs_projection(run_id),
  job_id TEXT NOT NULL REFERENCES jobs_projection(job_id),
  attempt_id TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  workflow_version INTEGER NOT NULL,
  workflow_digest TEXT NOT NULL CHECK (length(workflow_digest) = 64),
  source_revision_id TEXT NOT NULL REFERENCES source_revisions_projection(revision_id),
  verifier_contract_digest TEXT NOT NULL CHECK (length(verifier_contract_digest) = 64),
  artifact_manifest_id TEXT REFERENCES artifact_manifests_projection(artifact_manifest_id),
  status TEXT NOT NULL CHECK (status IN ('requested', 'passed', 'failed', 'invalid', 'cancelled')),
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  result_digest TEXT CHECK (result_digest IS NULL OR length(result_digest) = 64),
  receipt_digest TEXT CHECK (receipt_digest IS NULL OR length(receipt_digest) = 64),
  exit_code INTEGER,
  failure_reason TEXT,
  requested_at TEXT NOT NULL,
  completed_at TEXT,
  version INTEGER NOT NULL CHECK (version > 0),
  UNIQUE (attempt_id)
) STRICT;

CREATE TABLE workflows_projection (
  workflow_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  name TEXT NOT NULL,
  definition_json TEXT NOT NULL CHECK (json_valid(definition_json)),
  definition_digest TEXT NOT NULL,
  registered_at TEXT NOT NULL,
  stream_version INTEGER NOT NULL CHECK (stream_version > 0),
  PRIMARY KEY (workflow_id, version)
) STRICT;

CREATE INDEX advisor_audit_backlog_idx
ON advisor_audits_projection (status, due_at, audit_id);

CREATE INDEX advisor_case_family_idx
ON advisor_cases_projection (source_family, program_id, case_id);

CREATE INDEX advisor_evaluation_policy_idx
ON advisor_evaluations_projection (policy_revision_id, report_id);

CREATE INDEX advisor_incident_status_idx
ON advisor_incidents_projection (status, policy_revision_id, incident_id);

CREATE INDEX advisor_invocation_claim_idx
ON advisor_invocations_projection (status, available_at, invocation_id);

CREATE INDEX advisor_recommendation_subject_idx
ON advisor_recommendations_projection (subject_id, purpose, recommendation_id);

CREATE INDEX approval_requests_run_idx
ON approval_requests_projection (run_id, requested_at, approval_request_id);

CREATE INDEX attention_budget_program_idx
ON attention_budget_incidents_projection (program_id, incident_id);

CREATE INDEX attention_deliveries_claim_idx
ON attention_deliveries_projection (status, available_at, delivery_id);

CREATE INDEX attention_program_idx
ON attention_spans_projection (program_id, started_at, attention_span_id);

CREATE INDEX concurrency_lease_claim_idx
ON concurrency_leases_projection (status, claim_key, lease_id);

CREATE INDEX decision_packets_queue_idx
ON decision_packets_projection (status, program_id, packet_id);

CREATE INDEX decision_policy_status_idx
ON decision_policies_projection (status, policy_id, revision);

CREATE INDEX decision_revisions_packet_idx
ON decision_packet_revisions_projection (packet_id, revision);

CREATE INDEX driver_receipts_run_idx
ON driver_receipts_projection (run_id, recorded_at, driver_receipt_id);

CREATE INDEX events_command_id_idx ON events (command_id);

CREATE INDEX events_type_idx ON events (event_type, global_position);

CREATE INDEX generations_program_idx
ON milestone_generations_projection (program_id, started_at, generation_id);

CREATE INDEX graphs_program_idx
ON program_graphs_projection (program_id, revision);

CREATE INDEX integration_candidate_order_idx
ON integration_candidates_projection (target_id, status, admission_sequence, candidate_id);

CREATE INDEX integration_work_claim_idx
ON integration_work_projection (status, available_at, work_id);

CREATE INDEX issues_program_idx
ON routed_issues_projection (program_id, status, raised_at, issue_id);

CREATE INDEX jobs_claim_idx
ON jobs_projection (status, available_at, created_at, job_id);

CREATE INDEX measurement_program_idx
ON measurement_reports_projection (program_id, compiled_at, report_id);

CREATE INDEX milestones_program_idx
ON milestones_projection (program_id, approved_at, milestone_id);

CREATE INDEX outbox_claim_idx
ON outbox_projection (status, available_at, created_at, outbox_id);

CREATE INDEX outcome_packets_program_idx
ON outcome_packets_projection (program_id, recorded_at, outcome_packet_id);

CREATE INDEX portfolio_admission_order_idx
ON portfolio_admissions_projection (status, admission_sequence, admission_id);

CREATE INDEX portfolio_slo_status_idx
ON portfolio_slo_incidents_projection (status, policy_revision_id, incident_id);

CREATE INDEX verifications_run_idx ON verifications_projection (run_id, requested_at, verification_id);

CREATE TRIGGER command_receipts_no_delete
BEFORE DELETE ON command_receipts
BEGIN
  SELECT RAISE(ABORT, 'command receipts are append-only');
END;

CREATE TRIGGER command_receipts_no_update
BEFORE UPDATE ON command_receipts
BEGIN
  SELECT RAISE(ABORT, 'command receipts are append-only');
END;

CREATE TRIGGER events_no_delete
BEFORE DELETE ON events
BEGIN
  SELECT RAISE(ABORT, 'events are append-only');
END;

CREATE TRIGGER events_no_update
BEFORE UPDATE ON events
BEGIN
  SELECT RAISE(ABORT, 'events are append-only');
END;

CREATE TRIGGER outbound_authority_events_no_delete
BEFORE DELETE ON outbound_authority_events
BEGIN
  SELECT RAISE(ABORT, 'outbound authority events are append-only');
END;

CREATE TRIGGER outbound_authority_events_no_update
BEFORE UPDATE ON outbound_authority_events
BEGIN
  SELECT RAISE(ABORT, 'outbound authority events are append-only');
END;

-- Seed singleton projection metadata.
INSERT INTO "projection_meta" ("singleton", "last_applied_position") VALUES (1, 0);
