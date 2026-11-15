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

    def test_google_official_endpoint_and_argon_reasoning(self):
        cfg={**translate.google_config(self.cfg),'api_key':'google-test-key'}
        payload=json.dumps({'choices':[{'message':{'content':'{"1":"猫"}'}}]}).encode('utf-8')
        with mock.patch.object(translate.urllib.request,'urlopen',return_value=io.BytesIO(payload)) as request:
            result,_=translate.translate_batch(cfg,[('cat',1)])
        sent=request.call_args.args[0]
        self.assertEqual(sent.full_url,'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions')
        self.assertEqual(sent.get_header('Authorization'),'Bearer google-test-key')
        body=json.loads(sent.data)
        self.assertEqual(body['model'],'gemini-4-argon')
        self.assertEqual(body['reasoning_effort'],'high')
        self.assertEqual(body['response_format'],{'type':'json_object'})
        self.assertEqual(result,{'cat':'猫'})

    def test_configured_chat_endpoint_is_not_appended_twice(self):
        for base,expected in [('https://relay.invalid','https://relay.invalid/v1/chat/completions'),
                              ('https://relay.invalid/v1/','https://relay.invalid/v1/chat/completions'),
                              (translate.GOOGLE_BASE_URL+'/chat/completions',translate.GOOGLE_BASE_URL+'/chat/completions')]:
            with self.subTest(base=base), mock.patch.object(translate.urllib.request,'urlopen',
                    return_value=io.BytesIO(b'{"choices":[{"message":{"content":"{}"}}]}')) as request:
                translate.translate_batch({**self.cfg,'base_url':base},[('cat',1)])
                self.assertEqual(request.call_args.args[0].full_url,expected)

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

    def test_google_composite_filter_reason_does_not_require_message(self):
        for reason in ('content_filter: PROHIBITED_CONTENT', 'content_filter: OTHER',
                       'Content_Filter: SAFETY'):
            payload={'choices':[{'finish_reason':reason,'index':0}]}
            with self.subTest(reason=reason), \
                 mock.patch.object(translate.urllib.request,'urlopen',side_effect=lambda *args,**kwargs: io.BytesIO(json.dumps(payload).encode('utf-8'))) as request, \
                 mock.patch.object(translate.time,'sleep') as sleep, mock.patch.object(translate,'log'):
                with self.assertRaisesRegex(translate.ContentBlockedError,'CONTENT_FILTER'):
                    translate.translate_batch(self.cfg,[('ordinary-item',1)])
                self.assertEqual(request.call_count,1)
                sleep.assert_not_called()

    def test_missing_message_keeps_finish_reason_in_diagnostic(self):
        payload={'choices':[{'finish_reason':'other','index':0}]}
        with mock.patch.object(translate.urllib.request,'urlopen',return_value=io.BytesIO(json.dumps(payload).encode('utf-8'))), \
             mock.patch.object(translate,'log') as log:
            result,_=translate.translate_batch(self.cfg,[('cat',1)],attempt_budget=1)
        self.assertIsNone(result)
        diagnostic=' '.join(str(call.args[0]) for call in log.call_args_list)
        self.assertIn('finish_reason=OTHER',diagnostic)
        self.assertNotIn('KeyError',diagnostic)

    def test_null_message_and_empty_content_remain_unavailable(self):
        for choice in ({'message':None}, {'message':{'content':None}},
                       {'message':{'content':''}}):
            payload={'choices':[{**choice,'finish_reason':'stop'}]}
            with self.subTest(choice=choice), \
                 mock.patch.object(translate.urllib.request,'urlopen',return_value=io.BytesIO(json.dumps(payload).encode('utf-8'))), \
                 mock.patch.object(translate,'log') as log:
                result,_=translate.translate_batch(self.cfg,[('cat',1)],attempt_budget=1)
                self.assertIsNone(result)
                self.assertIn('finish_reason=STOP',' '.join(str(call.args[0]) for call in log.call_args_list))

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


class TranslationConfigTests(unittest.TestCase):
    def test_google_config_removes_plaintext_key_and_preserves_batch_settings(self):
        original={'api_key':'old-secret','model':'old-model','batch_size':60,'concurrency':24}
        cfg=translate.google_config(original)
        self.assertNotIn('api_key',cfg)
        self.assertEqual(cfg['api_key_credential'],translate.GOOGLE_CREDENTIAL)
        self.assertEqual((cfg['batch_size'],cfg['concurrency']),(60,24))
        self.assertEqual(original['api_key'],'old-secret')

    def test_credentials_are_loaded_only_for_real_requests(self):
        with tempfile.TemporaryDirectory() as directory:
            config_path=Path(directory)/'config.json'
            config_path.write_text(json.dumps(translate.google_config({})),encoding='utf-8')
            with mock.patch.object(translate,'CONFIG_PATH',config_path), \
                 mock.patch.object(translate,'read_api_key',return_value='secret-from-windows') as read:
                dry=translate.load_config(resolve_key=False)
                read.assert_not_called()
                self.assertNotIn('api_key',dry)
                self.assertEqual(translate.load_config()['api_key'],'secret-from-windows')
                read.assert_called_once_with(translate.GOOGLE_CREDENTIAL)
                self.assertNotIn('secret-from-windows',config_path.read_text(encoding='utf-8'))

    def test_missing_credential_reports_setup_entrypoint(self):
        with tempfile.TemporaryDirectory() as directory:
            config_path=Path(directory)/'config.json'
            config_path.write_text(json.dumps(translate.google_config({})),encoding='utf-8')
            with mock.patch.object(translate,'CONFIG_PATH',config_path), \
                 mock.patch.object(translate,'read_api_key',return_value=''):
                with self.assertRaisesRegex(SystemExit,'--set-api-key'):
                    translate.load_config()

    def test_setup_action_does_not_load_tables_or_start_requests(self):
        with mock.patch.object(translate,'set_api_key',return_value=0) as setup, \
             mock.patch.object(translate,'load_config') as load, \
             mock.patch.object(translate,'pending_keys') as pending:
            self.assertEqual(translate.main(['--set-api-key']),0)
        setup.assert_called_once_with()
        load.assert_not_called()
        pending.assert_not_called()


class TranslationBlockedTests(unittest.TestCase):
    def setUp(self):
        directory=tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.blocked_path=Path(directory.name)/'blocked.csv'
        patch=mock.patch.object(translate,'BLOCKED_PATH',self.blocked_path,create=True)
        patch.start()
        self.addCleanup(patch.stop)

    def test_blocked_records_persist_reason_model_and_deduplicate_keys(self):
        with mock.patch.object(translate,'SOURCE_LABEL','gemini-4-argon'):
            translate.append_blocked([('Cat',3,'SAFETY'),('cat',2,'CONTENT_FILTER:OTHER')])
            translate.append_blocked([('cat',2,'SAFETY')])
        self.assertEqual(translate.load_blocked_keys(),{'cat'})
        with self.blocked_path.open(encoding='utf-8-sig',newline='') as handle:
            rows=list(csv.DictReader(handle))
        self.assertEqual(len(rows),1)
        self.assertEqual(rows[0]['原因'],'SAFETY')
        self.assertEqual(rows[0]['模型'],'gemini-4-argon')
        self.assertTrue(rows[0]['日期'])

    def test_next_queue_excludes_blocked_even_when_retrying_empty_names(self):
        translate.append_blocked([('blocked-key',3,'SAFETY')])
        with mock.patch.object(translate.btz,'read_json',return_value={}), \
             mock.patch.object(translate.btz,'load_dictionary',return_value=({},set())), \
             mock.patch.object(translate.btz,'load_table',return_value={}), \
             mock.patch.object(translate.btz,'collect_usage',return_value=(
                 {'blocked-key':3,'empty-key':2,'retry-service':1},None,None,None,set())), \
             mock.patch.object(translate.btz,'ai_eligible',return_value=True), \
             mock.patch.object(translate.btz,'resolve',return_value=('','')), \
             mock.patch.object(translate,'filtered',return_value=False), \
             mock.patch.object(translate,'load_empty_keys',return_value={'empty-key'}):
            pending,_,stats=translate.pending_keys()
            self.assertEqual(pending,[('retry-service',1)])
            self.assertEqual(stats['本轮跳过拦截'],1)
            pending,_,_=translate.pending_keys(skip_empty=False)
            self.assertEqual(pending,[('empty-key',2),('retry-service',1)])


class TranslationMainTests(unittest.TestCase):
    def setUp(self):
        TranslationRequestTests.setUp(self)
        directory=tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        patch=mock.patch.object(translate,'BLOCKED_PATH',Path(directory.name)/'blocked.csv',create=True)
        patch.start()
        self.addCleanup(patch.stop)

    error = TranslationRequestTests.error

    def content_case(self,words,blocked,batch_size=2,compatible_filter=False):
        with tempfile.TemporaryDirectory() as directory, ExitStack() as stack:
            root=Path(directory)
            for name,value in [('LOG_PATH',root/'run.log'),('REPORT_PATH',root/'report.md'),
                               ('FAILED_PATH',root/'failed.csv'),('EMPTY_PATH',root/'empty.csv'),
                               ('BLOCKED_PATH',root/'blocked.csv')]:
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
                    if compatible_filter:
                        return io.BytesIO(b'{"choices":[{"finish_reason":"content_filter: PROHIBITED_CONTENT","index":0}]}')
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
                    'blocked':csv_rows(root/'blocked.csv'),
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

    def test_google_filter_without_message_is_recorded_without_negative_cache(self):
        result=self.content_case(['blocked-key','first-good','later-good','last-good'],
                                 {'blocked-key'},compatible_filter=True)
        self.assertEqual(result['code'],0)
        self.assertEqual(len(result['requests']),4)
        self.assertEqual({row[0] for row in result['ai'][1:]},{'first-good','later-good','last-good'})
        self.assertEqual(result['empty'],[])
        self.assertEqual(result['failed'][1][2],'CONTENT_FILTER:PROHIBITED_CONTENT')
        self.assertEqual([row[0] for row in result['blocked'][1:]],['blocked-key'])
        self.assertEqual(result['blocked'][1][2],'CONTENT_FILTER:PROHIBITED_CONTENT')
        self.assertNotIn('KeyError',result['report'])

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
            blocked=stack.enter_context(mock.patch.object(translate,'append_blocked',create=True))
            stack.enter_context(mock.patch.object(translate.time,'sleep'))
            stack.enter_context(mock.patch('sys.stdout',new_callable=io.StringIO))
            self.assertNotEqual(translate.main([]),0)
            self.assertEqual(request.call_count,4)
            pool.assert_not_called()
            empty.assert_not_called()
            blocked.assert_not_called()

    def test_blocked_record_survives_interruption_before_report(self):
        with tempfile.TemporaryDirectory() as directory, ExitStack() as stack:
            root=Path(directory)
            for name,value in [('LOG_PATH',root/'run.log'),('REPORT_PATH',root/'report.md'),
                               ('FAILED_PATH',root/'failed.csv'),('EMPTY_PATH',root/'empty.csv')]:
                stack.enter_context(mock.patch.object(translate,name,value))
            stack.enter_context(mock.patch.object(translate.btz,'REPORT_DIR',root))
            stack.enter_context(mock.patch.object(translate,'load_config',return_value={**self.cfg,'batch_size':1,'concurrency':1}))
            stack.enter_context(mock.patch.object(translate,'pending_keys',return_value=(
                [('blocked-key',1),('later-key',1)],0,{'本轮跳过无译名':0,'已知无译名':0})))
            stack.enter_context(mock.patch.object(translate,'translate_batch',side_effect=[
                translate.ContentBlockedError('SAFETY'),KeyboardInterrupt()]))
            stack.enter_context(mock.patch('sys.stdout',new_callable=io.StringIO))
            with self.assertRaises(KeyboardInterrupt):
                translate.main([])
            self.assertEqual(translate.load_blocked_keys(),{'blocked-key'})
            self.assertFalse((root/'report.md').exists())

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
