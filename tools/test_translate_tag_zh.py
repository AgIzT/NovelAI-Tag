"""Relay failure handling uses in-memory responses; never read credentials or call a relay."""
import io
import csv
import json
import tempfile
import unittest
import urllib.error
from contextlib import ExitStack
from pathlib import Path
from unittest import mock

from tools import translate_tag_zh as translate


class TranslationRequestTests(unittest.TestCase):
    def setUp(self):
        self.cfg={'base_url':'https://relay.invalid','api_key':'sk-test-secret','model':'gemini-4-carbon-high'}

    def error(self,status,message):
        return urllib.error.HTTPError('https://relay.invalid/v1/chat/completions',status,'error',{},
            io.BytesIO(json.dumps({'error':{'message':message}}).encode('utf-8')))

    def test_forbidden_stops_without_retry_or_split_signal(self):
        error=self.error(403,'token cannot access model gemini-4-carbon-high')
        with mock.patch.object(translate.urllib.request,'urlopen',side_effect=error) as request, \
             mock.patch.object(translate.time,'sleep') as sleep, mock.patch.object(translate,'log'):
            with self.assertRaisesRegex(RuntimeError,'HTTP 403'):
                translate.translate_batch(self.cfg,[('cat',1),('dog',1)])
        self.assertEqual(request.call_count,1)
        sleep.assert_not_called()

    def test_error_details_are_kept_but_api_key_is_redacted(self):
        error=self.error(401,'bad key '+self.cfg['api_key'])
        with mock.patch.object(translate.urllib.request,'urlopen',side_effect=error), \
             mock.patch.object(translate.time,'sleep'), mock.patch.object(translate,'log'):
            try:
                translate.translate_batch(self.cfg,[('cat',1)])
            except RuntimeError as caught:
                self.assertIn('bad key',str(caught))
                self.assertNotIn(self.cfg['api_key'],str(caught))
            else:
                self.fail('Authorization error was silently converted to a split candidate')

    def test_service_failure_is_bounded_and_not_a_split_candidate(self):
        error=self.error(503,'temporarily unavailable')
        with mock.patch.object(translate.urllib.request,'urlopen',side_effect=error) as request, \
             mock.patch.object(translate.time,'sleep'), mock.patch.object(translate,'log'):
            with self.assertRaisesRegex(RuntimeError,'HTTP 503'):
                translate.translate_batch(self.cfg,[('cat',1),('dog',1)],attempt_budget=2)
        self.assertEqual(request.call_count,2)

    def test_empty_choices_still_allow_content_batch_split(self):
        def response(*args,**kwargs):
            return io.BytesIO(b'{"choices":[],"usage":{}}')
        with mock.patch.object(translate.urllib.request,'urlopen',side_effect=response) as request, \
             mock.patch.object(translate.time,'sleep'), mock.patch.object(translate,'log'):
            value,usage=translate.translate_batch(self.cfg,[('cat',1),('dog',1)])
        self.assertIsNone(value)
        self.assertEqual(request.call_count,2)

    def test_success_preserves_number_mapping(self):
        content=json.dumps({'1':'猫','2':'狗'},ensure_ascii=False)
        payload=json.dumps({'choices':[{'message':{'content':content}}],'usage':{'prompt_tokens':4}}).encode('utf-8')
        with mock.patch.object(translate.urllib.request,'urlopen',return_value=io.BytesIO(payload)):
            value,usage=translate.translate_batch(self.cfg,[('cat',3),('dog',2)])
        self.assertEqual(value,{'cat':'猫','dog':'狗'})
        self.assertEqual(usage['prompt_tokens'],4)

    def test_explicit_content_errors_are_not_permission_errors(self):
        for status in (400,403,422):
            with self.subTest(status=status), \
                 mock.patch.object(translate.urllib.request,'urlopen',side_effect=self.error(status,'request blocked by Gemini API: PROHIBITED_CONTENT')) as request, \
                 mock.patch.object(translate.time,'sleep') as sleep:
                with self.assertRaises(translate.ContentBlockedError):
                    translate.translate_batch(self.cfg,[('ordinary-item',1)])
                self.assertEqual(request.call_count,1)
                sleep.assert_not_called()

    def test_finish_reason_and_prompt_feedback_are_recognized(self):
        cases=[
            {'choices':[{'finish_reason':'content_filter','message':{'content':None}}]},
            {'choices':[{'message':{'refusal':'Cannot process this item'}}]},
            {'promptFeedback':{'blockReason':'SAFETY'}},
            {'prompt_feedback':{'block_reason':'OTHER'}},
            {'candidates':[{'finishReason':'PROHIBITED_CONTENT'}]},
        ]
        for payload in cases:
            with self.subTest(payload=payload), \
                 mock.patch.object(translate.urllib.request,'urlopen',return_value=io.BytesIO(json.dumps(payload).encode('utf-8'))) as request:
                with self.assertRaises(translate.ContentBlockedError):
                    translate.translate_batch(self.cfg,[('ordinary-item',1)])
                self.assertEqual(request.call_count,1)

    def test_unrelated_bad_request_remains_fatal(self):
        with mock.patch.object(translate.urllib.request,'urlopen',side_effect=self.error(400,'invalid request parameter')) as request:
            with self.assertRaises(translate.FatalTranslationError):
                translate.translate_batch(self.cfg,[('ordinary-item',1)])
        self.assertEqual(request.call_count,1)

    def test_http_error_response_is_closed(self):
        error=self.error(403,'model not allowed')
        response=error.fp
        with mock.patch.object(translate.urllib.request,'urlopen',side_effect=error):
            with self.assertRaises(translate.FatalTranslationError):
                translate.translate_batch(self.cfg,[('ordinary-item',1)])
        self.assertTrue(response.closed)


class TranslationMainTests(unittest.TestCase):
    setUp = TranslationRequestTests.setUp
    error = TranslationRequestTests.error

    def content_case(self,words,blocked,batch_size=2):
        with tempfile.TemporaryDirectory() as directory, ExitStack() as stack:
            root=Path(directory)
            for name,value in [('LOG_PATH',root/'run.log'),('REPORT_PATH',root/'report.md'),
                               ('FAILED_PATH',root/'failed.csv'),('EMPTY_PATH',root/'empty.csv')]:
                stack.enter_context(mock.patch.object(translate,name,value))
            stack.enter_context(mock.patch.object(translate.btz,'REPORT_DIR',root))
            stack.enter_context(mock.patch.object(translate.btz,'AI_PATH',root/'ai.csv'))
            stack.enter_context(mock.patch.object(translate,'load_config',return_value={**self.cfg,'batch_size':batch_size,'concurrency':2}))
            stack.enter_context(mock.patch.object(translate,'pending_keys',return_value=([(word,1) for word in words],0,{'本轮跳过无译名':0,'已知无译名':0})))
            requests=[]
            def response(request,**kwargs):
                body=json.loads(request.data)
                keys=[line.split('. ',1)[1] for line in body['messages'][-1]['content'].splitlines()]
                requests.append(keys)
                if any(word in blocked for word in keys):
                    raise self.error(400,'request blocked by Gemini API: PROHIBITED_CONTENT')
                text=json.dumps({str(i):'普通译名' for i,_word in enumerate(keys,1)},ensure_ascii=False)
                return io.BytesIO(json.dumps({'choices':[{'message':{'content':text}}]}).encode('utf-8'))
            stack.enter_context(mock.patch.object(translate.urllib.request,'urlopen',side_effect=response))
            stack.enter_context(mock.patch.object(translate.time,'sleep'))
            stack.enter_context(mock.patch('sys.stdout',new_callable=io.StringIO))
            code=translate.main([])
            def csv_rows(path):
                if not path.exists():return []
                with path.open(encoding='utf-8-sig',newline='') as handle:return list(csv.reader(handle))
            return {'code':code,'requests':requests,'ai':csv_rows(root/'ai.csv'),'empty':csv_rows(root/'empty.csv'),
                    'failed':csv_rows(root/'failed.csv'),'report':(root/'report.md').read_text(encoding='utf-8')}

    def test_content_block_splits_unchanged_inputs_and_continues_later_batches(self):
        result=self.content_case(['blocked-key','first-good','later-good','last-good'],{'blocked-key'})
        self.assertEqual(result['code'],0)
        self.assertEqual({row[0] for row in result['ai'][1:]},{'first-good','later-good','last-good'})
        self.assertEqual(len(result['requests']),4)
        self.assertEqual(result['requests'][0],['blocked-key','first-good'])
        self.assertIn(['blocked-key'],result['requests'])
        self.assertIn(['first-good'],result['requests'])
        self.assertIn(['later-good','last-good'],result['requests'])
        self.assertEqual(result['empty'],[])
        self.assertEqual(len(result['failed']),2)
        self.assertEqual(result['failed'][1][0],'blocked-key')
        self.assertIn('PROHIBITED_CONTENT',result['failed'][1][2])

    def test_entire_first_batch_blocked_does_not_stop_later_batches(self):
        result=self.content_case(['blocked-one','blocked-two','later-good','last-good'],{'blocked-one','blocked-two'})
        self.assertEqual(result['code'],0)
        self.assertEqual({row[0] for row in result['ai'][1:]},{'later-good','last-good'})
        self.assertEqual(len(result['requests']),4)
        self.assertEqual(result['empty'],[])
        self.assertEqual({row[0] for row in result['failed'][1:]},{'blocked-one','blocked-two'})

    def test_large_batch_can_split_past_six_levels_to_one_item(self):
        words=['blocked-key']+[f'good-{i:03d}' for i in range(129)]
        result=self.content_case(words,{'blocked-key'},batch_size=128)
        self.assertEqual(result['code'],0)
        self.assertEqual({row[0] for row in result['ai'][1:]},set(words)-{'blocked-key'})
        self.assertIn(['blocked-key'],result['requests'])
        self.assertEqual(len(result['failed']),2)
        self.assertEqual(result['empty'],[])

    def test_first_batch_checks_permission_before_parallel_work(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            stats={'本轮跳过无译名':0,'已知无译名':0}
            patches=[mock.patch.object(translate,'load_config',return_value={**self.cfg,'batch_size':1,'concurrency':24}),
                     mock.patch.object(translate,'pending_keys',return_value=([('cat',1),('dog',1)],0,stats)),
                     mock.patch.object(translate.btz,'REPORT_DIR',root),
                     mock.patch.object(translate,'LOG_PATH',root/'run.log'),
                     mock.patch.object(translate,'REPORT_PATH',root/'report.md'),
                     mock.patch.object(translate,'FAILED_PATH',root/'failed.csv'),
                     mock.patch.object(translate,'EMPTY_PATH',root/'empty.csv'),
                     mock.patch.object(translate,'append_rows'),mock.patch.object(translate,'append_empty')]
            for patch in patches:patch.start();self.addCleanup(patch.stop)
            with mock.patch.object(translate.urllib.request,'urlopen',side_effect=self.error(403,'model not allowed')) as request, \
                 mock.patch.object(translate,'ThreadPoolExecutor') as pool, \
                 mock.patch.object(translate.time,'sleep'),mock.patch('sys.stdout',new_callable=io.StringIO):
                code=translate.main([])
            self.assertNotEqual(code,0)
            self.assertEqual(request.call_count,1)
            pool.assert_not_called()
            translate.append_rows.assert_not_called()
            translate.append_empty.assert_not_called()
            self.assertIn('403',(root/'report.md').read_text(encoding='utf-8'))

    def test_service_outage_does_not_expand_into_child_requests(self):
        with tempfile.TemporaryDirectory() as directory, ExitStack() as stack:
            root=Path(directory)
            for name,value in [('LOG_PATH',root/'run.log'),('REPORT_PATH',root/'report.md'),
                               ('FAILED_PATH',root/'failed.csv'),('EMPTY_PATH',root/'empty.csv')]:
                stack.enter_context(mock.patch.object(translate,name,value))
            stack.enter_context(mock.patch.object(translate.btz,'REPORT_DIR',root))
            stack.enter_context(mock.patch.object(translate,'load_config',return_value={**self.cfg,'batch_size':30,'concurrency':24}))
            stack.enter_context(mock.patch.object(translate,'pending_keys',return_value=([('cat',1),('dog',1)],0,{'本轮跳过无译名':0,'已知无译名':0})))
            request=stack.enter_context(mock.patch.object(translate.urllib.request,'urlopen',side_effect=self.error(503,'service unavailable')))
            pool=stack.enter_context(mock.patch.object(translate,'ThreadPoolExecutor'))
            empty=stack.enter_context(mock.patch.object(translate,'append_empty'))
            stack.enter_context(mock.patch.object(translate.time,'sleep'))
            stack.enter_context(mock.patch('sys.stdout',new_callable=io.StringIO))
            self.assertNotEqual(translate.main([]),0)
            self.assertEqual(request.call_count,4)
            pool.assert_not_called()
            empty.assert_not_called()

    def test_successful_run_streams_progress_and_records_actual_model(self):
        with tempfile.TemporaryDirectory() as directory, ExitStack() as stack:
            root=Path(directory)
            for name,value in [('LOG_PATH',root/'run.log'),('REPORT_PATH',root/'report.md'),
                               ('FAILED_PATH',root/'failed.csv'),('EMPTY_PATH',root/'empty.csv')]:
                stack.enter_context(mock.patch.object(translate,name,value))
            stack.enter_context(mock.patch.object(translate.btz,'REPORT_DIR',root))
            stack.enter_context(mock.patch.object(translate.btz,'AI_PATH',root/'ai.csv'))
            stack.enter_context(mock.patch.object(translate,'load_config',return_value={**self.cfg,'batch_size':1,'concurrency':2}))
            stack.enter_context(mock.patch.object(translate,'pending_keys',return_value=([('cat',1),('dog',1)],0,{'本轮跳过无译名':0,'已知无译名':0})))
            def response(request,**kwargs):
                body=json.loads(request.data)
                word=body['messages'][-1]['content'].split('. ',1)[1]
                text=json.dumps({'1':{'cat':'猫','dog':'狗'}[word]},ensure_ascii=False)
                return io.BytesIO(json.dumps({'choices':[{'message':{'content':text}}]}).encode('utf-8'))
            request=stack.enter_context(mock.patch.object(translate.urllib.request,'urlopen',side_effect=response))
            output=stack.enter_context(mock.patch('sys.stdout',new_callable=io.StringIO))
            self.assertEqual(translate.main([]),0)
            self.assertEqual(request.call_count,2)
            with (root/'ai.csv').open(encoding='utf-8-sig',newline='') as handle:
                rows=list(csv.reader(handle))
            self.assertEqual([r[0] for r in rows[1:]],['cat','dog'])
            self.assertEqual([r[2] for r in rows[1:]],[self.cfg['model']]*2)
            self.assertIn('先检查首批请求',output.getvalue())
            self.assertIn('1/2 批',output.getvalue())
            self.assertIn('2/2 批',output.getvalue())


if __name__=='__main__':
    unittest.main()
