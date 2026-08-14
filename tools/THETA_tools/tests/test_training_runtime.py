from __future__ import annotations

import tempfile
import unittest
import sys
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from THETA_tools import runner, tools


class TrainingRuntimeRecoveryTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="theta-runtime-test-")
        root = Path(self.temp.name)
        self.dataset_path = root / "dataset.csv"
        self.dataset_path.write_text("text\nA governed runtime fixture.\n", encoding="utf-8")
        self.state_dir_patch = patch.object(tools, "STATE_DIR", root)
        self.state_db_patch = patch.object(
            tools, "STATE_DB_PATH", root / "state.sqlite"
        )
        self.runs_dir_patch = patch.object(tools, "RUNS_DIR", root / "runs")
        self.spawn_patch = patch.object(
            tools, "spawn_training_runner", return_value=999_999_991
        )
        for active_patch in (
            self.state_dir_patch,
            self.state_db_patch,
            self.runs_dir_patch,
            self.spawn_patch,
        ):
            active_patch.start()

    def tearDown(self) -> None:
        patch.stopall()
        self.temp.cleanup()

    def training_payload(self, idempotency_key: str) -> dict:
        plan_id = "plan_" + "1" * 16
        plan_review_id = "approval_" + "3" * 20
        training_review_id = "approval_" + "4" * 20
        canonical_plan = {
            "schemaVersion": "2.0.0",
            "datasetId": "runtime-test",
            "model": {
                "modelId": "lda",
                "mode": "unsupervised",
                "topicCountMode": "fixed",
                "numTopics": 5,
                "maxTopics": None,
                "parameters": {},
            },
            "columns": {
                "textColumns": ["text"],
                "timeColumn": None,
                "idColumn": None,
                "covariateColumns": [],
                "metadataColumns": [],
                "groupingColumns": [],
                "evaluationLabelColumns": [],
            },
            "resources": {"device": "cpu"},
            "experimentProtocol": {
                "mode": "quick",
                "primarySeeds": [42],
                "baselineModelId": None,
                "baselineSeeds": [],
                "rationale": "Runtime test quick run.",
                "evidenceRefs": [],
                "confidence": "low",
            },
        }
        plan_hash = tools.sha256_json(canonical_plan)
        plan_record = {
            "planId": plan_id,
            "planHash": plan_hash,
            "canonicalPlan": canonical_plan,
        }
        resolved_plan = tools.legacy_plan_from_record(
            plan_record,
            self.dataset_path,
        )
        commands = tools.build_training_commands(resolved_plan)
        expected_artifacts = tools.expected_training_artifacts(resolved_plan)
        dry_run_material = {
            "planId": plan_id,
            "planHash": plan_hash,
            "planReviewApprovalId": plan_review_id,
            "passed": True,
            "checks": [
                {
                    "code": "RUNTIME_TEST_PREFLIGHT",
                    "status": "pass",
                    "detail": "Canonical runtime fixture.",
                }
            ],
            "commands": commands,
            "expectedArtifacts": expected_artifacts,
            "notes": [],
        }
        dry_run_hash = tools.sha256_json(dry_run_material)
        return {
            "plan": plan_record,
            "planReview": {
                "approvalId": plan_review_id,
                "approvalType": "human_plan_review",
                "planId": plan_id,
                "planHash": plan_hash,
            },
            "dryRun": {
                **dry_run_material,
                "dryRunHash": dry_run_hash,
            },
            "trainingReview": {
                "approvalId": training_review_id,
                "approvalType": "human_training_review",
                "planId": plan_id,
                "planHash": plan_hash,
                "dryRunHash": dry_run_hash,
            },
            "idempotencyKey": idempotency_key,
        }

    def test_missing_runner_is_quarantined_and_failed_retry_is_explicit(self) -> None:
        first = tools.training_start(self.training_payload("runtime-recovery"))
        repeated = tools.training_start(self.training_payload("runtime-recovery"))
        self.assertEqual(repeated["trainingRunId"], first["trainingRunId"])
        self.assertEqual(repeated["status"], "quarantined")
        status = tools.training_status({"trainingRunId": first["trainingRunId"]})
        self.assertEqual(status["status"], "quarantined")
        self.assertIn("runner is absent", status["receipt"]["quarantineReason"])

        source = tools.training_start(self.training_payload("runtime-retry-source"))
        with tools.connect_state_db() as conn:
            tools.init_state_db(conn)
            conn.execute(
                """
                UPDATE training_runs
                SET status = 'failed', error_message = 'simulated failure'
                WHERE training_run_id = ?
                """,
                (source["trainingRunId"],),
            )

        with self.assertRaisesRegex(ValueError, "new idempotencyKey"):
            tools.training_start(self.training_payload("runtime-retry-source"))

        retry_payload = self.training_payload("runtime-retry-attempt-2")
        retry_payload["retryOfTrainingRunId"] = source["trainingRunId"]
        retry_payload["retryReason"] = "Operator approved a corrected retry."
        retry = tools.training_start(retry_payload)
        self.assertEqual(retry["attempt"], 2)
        self.assertEqual(retry["retryOfTrainingRunId"], source["trainingRunId"])

    def test_expected_artifacts_follow_dtm_preparation_layout(self) -> None:
        dtm_artifacts = tools.expected_training_artifacts(
            {
                "datasetId": "dataset",
                "modelId": "dtm",
                "userId": "local_user",
            }
        )
        self.assertEqual(
            dtm_artifacts[0]["path"],
            "third_party/THETA/result/baseline/dataset/data",
        )
        self.assertEqual(
            dtm_artifacts[1]["path"],
            "third_party/THETA/result/local_user/dataset/dtm/approved_plan__primary_dtm_s42",
        )

        baseline_artifacts = tools.expected_training_artifacts(
            {
                "datasetId": "dataset",
                "modelId": "btm",
                "userId": "local_user",
            }
        )
        self.assertEqual(
            baseline_artifacts[0]["path"],
            "third_party/THETA/data/workspace/dataset/local_user",
        )
        self.assertEqual(
            baseline_artifacts[1]["path"],
            "third_party/THETA/result/local_user/dataset/btm/approved_plan__primary_btm_s42",
        )

    def test_training_phase_context_identifies_model_seed_and_run(self) -> None:
        phase = tools.training_phase_from_step(
            "run_pipeline_primary_dtm_s42",
            [
                {"step": "run_pipeline_primary_dtm_s42"},
                {"step": "run_pipeline_primary_dtm_s73"},
            ],
        )
        self.assertEqual(phase["currentPhase"], "training")
        self.assertEqual(phase["phaseContext"]["modelId"], "dtm")
        self.assertEqual(phase["phaseContext"]["seed"], 42)
        self.assertEqual(phase["phaseContext"]["runIndex"], 1)
        self.assertEqual(phase["phaseContext"]["totalRuns"], 2)

    def test_cpu_commands_hide_accelerators_in_child_environment(self) -> None:
        with patch.dict(
            "os.environ",
            {"CUDA_VISIBLE_DEVICES": "0", "NVIDIA_VISIBLE_DEVICES": "all"},
            clear=False,
        ):
            env = runner.compute_environment_for_argv(
                ["python", "main.py", "--gpu", "-1"]
            )
        self.assertEqual(env["THETA_COMPUTE_BACKEND"], "local")
        self.assertEqual(env["THETA_COMPUTE_DEVICE"], "cpu")
        self.assertEqual(env["CUDA_VISIBLE_DEVICES"], "-1")
        self.assertEqual(env["NVIDIA_VISIBLE_DEVICES"], "none")

    def test_gpu_commands_keep_explicit_visibility_configuration(self) -> None:
        with patch.dict("os.environ", {"CUDA_VISIBLE_DEVICES": "2"}, clear=False):
            env = runner.compute_environment_for_argv(
                ["python", "main.py", "--gpu", "0"]
            )
        self.assertEqual(env["THETA_COMPUTE_DEVICE"], "gpu")
        self.assertEqual(env["CUDA_VISIBLE_DEVICES"], "2")

    def test_quality_reassessment_receipts_are_append_only(self) -> None:
        artifacts = [{"path": "result/topics.csv", "sha256": "a" * 64}]
        first = tools.persist_quality_reassessment(
            "run_" + "b" * 12,
            artifacts,
            {
                "modelId": "lda",
                "profileVersion": "quality.v1",
                "status": "warning",
                "checks": [{"code": "TOPIC_DIVERSITY", "status": "warn", "detail": "Review."}],
                "assessedAt": "2026-08-04T00:00:00.000Z",
            },
        )
        second = tools.persist_quality_reassessment(
            "run_" + "b" * 12,
            artifacts,
            {
                "modelId": "lda",
                "profileVersion": "quality.v2",
                "status": "passed",
                "checks": [{"code": "TOPIC_DIVERSITY", "status": "pass", "detail": "Passed."}],
                "assessedAt": "2026-08-04T00:01:00.000Z",
            },
        )
        self.assertNotEqual(first["receiptId"], second["receiptId"])
        with tools.connect_state_db() as conn:
            tools.init_state_db(conn)
            count = conn.execute(
                "SELECT COUNT(*) AS count FROM quality_reassessments"
            ).fetchone()["count"]
        self.assertEqual(count, 2)


if __name__ == "__main__":
    unittest.main()
