import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from http.server import ThreadingHTTPServer

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from server import Store, make_handler


class ServerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = Store(self.temp.name)
        self.http = ThreadingHTTPServer(('127.0.0.1', 0), make_handler(self.store))
        self.thread = threading.Thread(target=self.http.serve_forever, daemon=True)
        self.thread.start()
        self.url = f'http://127.0.0.1:{self.http.server_port}'

    def tearDown(self):
        self.http.shutdown()
        self.http.server_close()
        self.thread.join()
        self.temp.cleanup()

    def request(self, path, method='GET', data=None, headers=None):
        if isinstance(data, dict):
            data = json.dumps(data).encode()
        return urlopen(Request(self.url + path, data=data, method=method, headers=headers or {}), timeout=5)

    def test_session_round_trip_and_revision_conflict(self):
        payload = {'name':'test', 'video':None, 'cues':[{'id':'a','start':0.7,'end':5.124,'text':'Hello'}], 'clips':[]}
        with self.request('/api/sessions', 'POST', payload) as r:
            session = json.load(r)
        session['cues'][0]['start'] = 1
        with self.request('/api/sessions/' + session['id'], 'PUT', session) as r:
            saved = json.load(r)
        self.assertEqual(saved['revision'], 2)
        self.assertEqual(self.store.get(session['id'])['cues'][0]['start'], 1)
        with self.assertRaises(HTTPError) as conflict:
            self.request('/api/sessions/' + session['id'], 'PUT', session)
        self.assertEqual(conflict.exception.code, 409)
        self.assertEqual(len(self.store.listing()), 1)

    def test_upload_range_seek_and_isolation(self):
        content = bytes(range(256)) * 100
        with self.request('/api/assets?name=example.mp4', 'POST', content) as r:
            asset = json.load(r)
        with self.request(asset['url'], headers={'Range':'bytes=100-199'}) as r:
            self.assertEqual(r.status, 206)
            self.assertEqual(r.read(), content[100:200])
            self.assertEqual(r.headers['Content-Range'], f'bytes 100-199/{len(content)}')
        with self.request(asset['url'], headers={'Range':'bytes=-20'}) as r:
            self.assertEqual(r.read(), content[-20:])
        with self.assertRaises(HTTPError) as outside:
            self.request(asset['url'], headers={'Range':'bytes=999999-'})
        self.assertEqual(outside.exception.code, 416)
        with self.assertRaises(HTTPError) as cross:
            self.request('/api/sessions', 'POST', {}, {'Origin':'https://external.example'})
        self.assertEqual(cross.exception.code, 403)
        with self.assertRaises(HTTPError) as traversal:
            self.request('/assets/%2e%2e/server.py')
        self.assertEqual(traversal.exception.code, 404)

    def test_new_session_does_not_change_previous(self):
        one = self.store.create({'name':'one','video':None,'cues':[],'clips':[]})
        two = self.store.create({'name':'two','video':None,'cues':[],'clips':[]})
        self.assertNotEqual(one['id'], two['id'])
        self.assertEqual(self.store.get(one['id'])['name'], 'one')
        self.assertEqual(len(self.store.listing()), 2)

    def test_reject_nan_invalid_timing_and_missing_recording(self):
        for start, end in [(float('nan'), 3), (3,2), (-1,2)]:
            with self.assertRaises(ValueError):
                self.store.create({'cues':[{'id':'c','start':start,'end':end,'text':'x'}]})
        with self.assertRaises(ValueError):
            self.store.create({'clips':[{'id':'c','asset':'missing.wav','cueId':None,'start':0,'offset':0,'duration':1}]})


if __name__ == '__main__':
    unittest.main()
