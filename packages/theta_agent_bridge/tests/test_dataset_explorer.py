from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from theta_agent_bridge.dataset.explorer import explore_dataset
from theta_agent_bridge.dataset.readers import load_dataset


class DatasetExplorerTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix='theta-dataset-explorer-')
        self.root = Path(self.temp.name)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def test_large_csv_uses_bounded_deterministic_reservoir(self) -> None:
        path = self.root / 'large.csv'
        with path.open('w', encoding='utf-8', newline='') as handle:
            handle.write('id,text\n')
            for index in range(10050):
                handle.write(f'{index},record-{index}\n')

        first = load_dataset(path, seed='fixed-seed')
        second = load_dataset(path, seed='fixed-seed')

        self.assertEqual(first.row_count, 10050)
        self.assertEqual(len(first.rows), 5000)
        self.assertTrue(first.rows_truncated)
        self.assertEqual(first.rows, second.rows)
        self.assertEqual(first.head_rows[0]['id'], '0')

    def test_explore_redacts_secrets_and_bounds_remote_sample(self) -> None:
        path = self.root / 'sensitive.jsonl'
        records = [
            {
                'text': f'user-{index} email person{index}@example.com token sk-secretvalue{index:04d}',
                'account_name': f'person-{index}',
                'ip': '192.168.1.10',
            }
            for index in range(30)
        ]
        path.write_text(
            '\n'.join(json.dumps(record, ensure_ascii=False) for record in records),
            encoding='utf-8',
        )

        result = explore_dataset({
            'filePath': str(path),
            'datasetRef': 'dataset_test',
            'datasetHash': 'a' * 64,
            'sampleSize': 100,
            'selectedColumns': ['text', 'account_name', 'ip'],
        })

        self.assertEqual(result['samplePolicy']['requestedRows'], 10)
        self.assertLessEqual(len(result['sampleRows']), 10)
        self.assertTrue(all('_theta_sample_id' in row for row in result['sampleRows']))
        self.assertTrue(result['redactionSummary']['applied'])
        serialized = json.dumps(
            result['sampleRows'] + result['columnProfiles'],
            ensure_ascii=False,
        )
        self.assertNotIn('@example.com', serialized)
        self.assertNotIn('sk-secretvalue', serialized)
        self.assertNotIn('192.168.1.10', serialized)
        self.assertNotIn('person-0', serialized)
        self.assertLessEqual(len(serialized.encode('utf-8')), 30 * 1024)

    def test_explore_returns_only_the_current_runtime_contract(self) -> None:
        path = self.root / 'sample-views.csv'
        path.write_text(
            'id,text,timestamp,category\n'
            '1,short,2026-01-01,A\n'
            '2,,not-a-date,B\n'
            '3,a much longer representative text value,2026-01-03,A\n',
            encoding='utf-8',
        )

        result = explore_dataset({
            'filePath': str(path),
            'datasetRef': 'dataset_samples',
            'datasetHash': 'd' * 64,
        })

        expected_keys = {
            'datasetRef',
            'datasetHash',
            'fileName',
            'format',
            'sizeBytes',
            'encoding',
            'delimiter',
            'sheets',
            'selectedSheet',
            'rowCount',
            'columns',
            'columnProfiles',
            'sampleRows',
            'sampleSeed',
            'samplePolicy',
            'sampleTruncated',
            'outputTruncated',
            'redactionSummary',
            'candidateRoles',
            'languageDistribution',
            'duplicateRatio',
            'timeCoverage',
            'inferredDomain',
            'qualityWarnings',
        }
        self.assertEqual(set(result), expected_keys)
        self.assertLessEqual(len(result['sampleRows']), 10)
        self.assertTrue(result['columnProfiles'])
        for legacy_key in (
            'profiles',
            'head',
            'sample',
            'exceptionalSample',
            'columnSamples',
            'redaction',
            'columnRoles',
        ):
            self.assertNotIn(legacy_key, result)

    def test_unknown_selected_column_is_rejected(self) -> None:
        path = self.root / 'dataset.csv'
        path.write_text('text\nhello\n', encoding='utf-8')
        with self.assertRaisesRegex(ValueError, 'Selected columns were not found'):
            explore_dataset({
                'filePath': str(path),
                'datasetRef': 'dataset_test',
                'datasetHash': 'b' * 64,
                'selectedColumns': ['missing'],
            })

    def test_column_roles_do_not_assign_identifiers_as_numeric_inputs(self) -> None:
        path = self.root / 'roles.csv'
        path.write_text(
            'id,text,timestamp,category,score\n'
            '1,first record,2026-01-01,A,0.8\n'
            '2,second record,2026-01-02,B,0.6\n'
            '3,third record,2026-01-03,A,0.9\n',
            encoding='utf-8',
        )

        result = explore_dataset({
            'filePath': str(path),
            'datasetRef': 'dataset_roles',
            'datasetHash': 'c' * 64,
        })
        roles = {
            role: [candidate['name'] for candidate in candidates]
            for role, candidates in result['candidateRoles'].items()
        }

        self.assertIn('id', roles['id'])
        self.assertNotIn('id', roles['covariate'])
        self.assertNotIn('id', roles['evaluation'])
        self.assertIn('score', roles['evaluation'])
        self.assertNotIn('score', roles['covariate'])


if __name__ == '__main__':
    unittest.main()
