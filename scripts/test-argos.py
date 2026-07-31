#!/usr/bin/env python3
import json
import sys

queue = json.load(open(sys.argv[1], encoding='utf-8'))
json.dump({
    'provider': 'argos', 'model': 'fixture-en-target',
    'translations': [{'id': row['id'], 'text': f"argos:{row['text']}"} for row in queue['rows']],
    'rejected': 0, 'timedOut': False,
}, open(sys.argv[2], 'w', encoding='utf-8'))
