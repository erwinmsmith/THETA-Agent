from __future__ import annotations

import re
from collections import Counter
from datetime import datetime
from typing import Any


TEXT_NAMES = {'text', 'content', 'body', 'message', 'review', 'comment', 'title', 'abstract', 'description'}
TIME_HINTS = ('time', 'date', 'created', 'updated', 'timestamp', 'year', 'month')
ID_HINTS = ('id', 'uuid', 'guid', 'key')
EVALUATION_HINTS = ('label', 'target', 'score', 'rating', 'outcome', 'ground_truth', 'gold')
DOMAINS = [
    ('法律与司法', ('法律', '法院', '合同', '刑法', '民法', '判决', '诉讼', '律师')),
    ('教育与学习', ('学习', '教育', '课程', '学生', '教师', '考试', '知识', '学校')),
    ('医疗与健康', ('医疗', '健康', '患者', '疾病', '治疗', '医院', '医生', '药物')),
    ('金融与商业', ('金融', '市场', '投资', '股票', '基金', '银行', '交易', '公司')),
    ('科技与互联网', ('技术', '软件', '代码', '算法', '模型', '人工智能', '网络', '数据')),
    ('新闻与公共议题', ('新闻', '报道', '社会', '政策', '政府', '事件', '公众', '媒体')),
    ('商品与用户反馈', ('商品', '产品', '评价', '评论', '购买', '客服', '质量', '价格')),
]


def profile(rows: list[dict[str, Any]], columns: list[str]) -> dict[str, Any]:
    profiles = [_profile_column(rows, column) for column in columns]
    roles = {
        'text': [],
        'time': [],
        'id': [],
        'group': [],
        'covariate': [],
        'evaluation': [],
        'metadata': [],
        'ignored': [],
    }
    for item in profiles:
        name = item['name']
        lower = name.lower()
        sample_count = max(1, item['nonEmptyCount'])
        unique_ratio = item['uniqueCount'] / sample_count
        text_score = (0.5 if lower in TEXT_NAMES else 0) + (0.3 if item['inferredType'] == 'text' else 0) + (0.2 if item['averageLength'] >= 20 else 0)
        if text_score:
            roles['text'].append(_candidate(name, min(1.0, text_score), '字段名、文本长度与唯一性'))
        time_score = (0.5 if any(hint in lower for hint in TIME_HINTS) else 0) + (0.45 if item['inferredType'] == 'datetime' else 0)
        if time_score:
            roles['time'].append(_candidate(name, min(1.0, time_score), '字段名与时间解析'))
        id_score = 0.75 if any(lower == hint or lower.endswith(f'_{hint}') for hint in ID_HINTS) else 0
        if id_score:
            roles['id'].append(_candidate(name, id_score, '字段名与高唯一性'))
        if item['inferredType'] in {'string', 'number'} and unique_ratio <= 0.5:
            score = max(0.1, 1 - unique_ratio)
            roles['metadata'].append(_candidate(name, score, '低基数元数据字段'))
            roles['group'].append(_candidate(name, score, '低基数分组候选'))
        is_evaluation = any(hint in lower for hint in EVALUATION_HINTS)
        is_primary_role = bool(text_score or time_score or id_score)
        if item['inferredType'] == 'number' and item['nonEmptyCount'] > 0 and not is_primary_role:
            if is_evaluation:
                roles['evaluation'].append(_candidate(name, 0.7, '字段名与数值类型表明其可能是评价标签'))
            else:
                roles['covariate'].append(_candidate(name, 0.55, '数值协变量候选'))
        if item['inferredType'] == 'empty' or item['missingRatio'] >= 0.95:
            roles['ignored'].append(_candidate(name, 0.95, '空值或近乎全缺失字段'))
    for values in roles.values():
        values.sort(key=lambda value: value['score'], reverse=True)
    text_column = roles['text'][0]['name'] if roles['text'] else None
    texts = [str(row.get(text_column) or '') for row in rows] if text_column else []
    return {
        'profiles': profiles,
        'columnRoles': roles,
        'languageDistribution': _languages(texts),
        'duplicateRatio': _duplicate_ratio(texts),
        'timeCoverage': _time_coverage(rows, [entry['name'] for entry in roles['time']]),
        'inferredDomain': _domain(texts, columns),
        'qualityWarnings': _warnings(rows, roles, profiles),
    }


def _profile_column(rows: list[dict[str, Any]], column: str) -> dict[str, Any]:
    values = [str(row.get(column)).strip() for row in rows if row.get(column) is not None and str(row.get(column)).strip()]
    lengths = [len(value) for value in values]
    return {
        'name': column,
        'inferredType': _infer_type(values),
        'nonEmptyCount': len(values),
        'missingRatio': round((len(rows) - len(values)) / max(1, len(rows)), 4),
        'uniqueCount': len(set(values)),
        'uniqueRatio': round(len(set(values)) / max(1, len(values)), 4),
        'averageLength': round(sum(lengths) / len(lengths), 2) if lengths else 0,
        'maximumLength': max(lengths) if lengths else 0,
        'parseSuccessRatio': _parse_success_ratio(values),
        'sampleValues': values[:5],
    }


def _parse_success_ratio(values: list[str]) -> float:
    if not values:
        return 0
    parsed = sum(1 for value in values if _number_or_datetime(value))
    return round(parsed / len(values), 4)


def _number_or_datetime(value: str) -> bool:
    try:
        return _number(value) or _datetime(value)
    except ValueError:
        return _datetime(value)


def _infer_type(values: list[str]) -> str:
    if not values:
        return 'empty'
    try:
        if all(_number(value) for value in values):
            return 'number'
    except ValueError:
        pass
    if sum(1 for value in values if _datetime(value)) >= max(1, int(len(values) * 0.6)):
        return 'datetime'
    if sum(1 for value in values if len(value) > 50) >= max(1, int(len(values) * 0.3)):
        return 'text'
    return 'string'


def _number(value: str) -> bool:
    float(value)
    return True


def _datetime(value: str) -> bool:
    if re.fullmatch(r'\d{4}([-/]\d{1,2}){0,2}', value):
        return True
    try:
        datetime.fromisoformat(value.replace('Z', '+00:00'))
        return True
    except ValueError:
        return False


def _candidate(name: str, score: float, reason: str) -> dict[str, Any]:
    return {'name': name, 'score': round(max(0, min(1, score)), 3), 'reason': reason}


def _languages(texts: list[str]) -> list[dict[str, Any]]:
    text = ''.join(texts)
    cjk = len(re.findall(r'[\u3400-\u9fff]', text))
    latin = len(re.findall(r'[A-Za-z]', text))
    total = cjk + latin
    if not total:
        return []
    return [entry for entry in (
        {'language': 'zh-Hans', 'ratio': cjk / total} if cjk else None,
        {'language': 'latin', 'ratio': latin / total} if latin else None,
    ) if entry]


def _duplicate_ratio(texts: list[str]) -> float:
    if not texts:
        return 0
    return round((len(texts) - len(set(texts))) / len(texts), 4)


def _time_coverage(rows: list[dict[str, Any]], columns: list[str]) -> dict[str, str | None]:
    values = sorted(str(row.get(column)) for row in rows for column in columns if row.get(column) is not None)
    return {'start': values[0] if values else None, 'end': values[-1] if values else None}


def _domain(texts: list[str], columns: list[str]) -> dict[str, Any]:
    corpus = (' '.join(texts) + ' ' + ' '.join(columns)).lower()[:120000]
    ranked = sorted(((label, [word for word in words if word in corpus]) for label, words in DOMAINS), key=lambda value: len(value[1]), reverse=True)
    label, evidence = ranked[0]
    if not evidence:
        return {'label': '通用文本分析', 'confidence': 0.35, 'evidence': ['未发现稳定的领域关键词']}
    return {'label': label, 'confidence': min(0.92, 0.5 + len(evidence) * 0.07), 'evidence': evidence[:8]}


def _warnings(rows: list[dict[str, Any]], roles: dict[str, list[Any]], profiles: list[dict[str, Any]]) -> list[str]:
    warnings = []
    if len(rows) < 100:
        warnings.append('样本量较小，主题与指标的稳定性有限。')
    if not roles['text']:
        warnings.append('未能确定唯一正文列，需要用户确认。')
    if any(item['missingRatio'] > 0.5 for item in profiles):
        warnings.append('部分字段缺失率超过 50%。')
    return warnings
