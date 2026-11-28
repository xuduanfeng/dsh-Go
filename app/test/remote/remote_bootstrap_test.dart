// The remote-command layer: probe/foreign-probe scripts and their parsing.
//
// The scripts run for real against the local /bin/sh with a fake `dsh`, in a
// temp HOME. dsh-Go never starts a server, so every case below asserts that no
// start command was executed. The SSH transport itself is covered by
// live_ssh_test.dart (opt-in).

import 'dart:io';

import 'package:dsh_app/remote/ssh/remote_bootstrap.dart';
import 'package:dsh_app/remote/ssh/remote_shell.dart';
import 'package:flutter_test/flutter_test.dart';

/// A stand-in `dsh web`: records its args, prints a launch line and idles like
/// a server (as a shell, so `ps` still shows "dsh" in its command line).
const _fakeDsh = r'''#!/bin/sh
printf '%s\n' "$*" >> "$HOME/dsh-args.txt"
echo "dsh web: http://127.0.0.1:4${FAKE_DSH_PORT:-1234}/?token=tok-$$"
i=0; while [ $i -lt 30 ]; do sleep 1; i=$((i+1)); done
''';

/// Only the tools the scripts use, so a dsh installed on this machine (in
/// /usr/bin) can't leak into the test.
const _tools = [
  'cat', 'grep', 'tail', 'sed', 'sleep', 'mkdir', 'chmod', 'rm', 'ps', 'pkill', //
  'nohup', 'ls', 'stat', 'getconf', 'cut', 'date', 'tr',
];

/// Records every script so a test can prove no start command was sent.
class _RecordingShell implements RemoteShell {
  _RecordingShell(this.inner);

  final RemoteShell inner;
  final scripts = <String>[];

  @override
  Future<RemoteExecResult> run(String script, {Duration timeout = const Duration(seconds: 30)}) {
    scripts.add(script);
    return inner.run(script, timeout: timeout);
  }
}

void main() {
  group('parsing', () {
    test('probe output: alive instance with a launch line is reusable', () {
      final probe = RemoteDshBootstrap.parseProbe('''
Welcome to Ubuntu!
DSHAPP home /home/me
DSHAPP alive 4242
DSHAPP url dsh web: http://127.0.0.1:38211/?token=AbC.d_e~f-9
''');
      expect(probe.home, '/home/me');
      expect(probe.pid, 4242);
      expect(probe.reusable, isTrue);
    });

    test('probe output: nothing running, or no launch line yet, is not reusable', () {
      expect(RemoteDshBootstrap.parseProbe('DSHAPP home /root\n').reusable, isFalse);
      // Alive but its log has no launch line yet.
      expect(RemoteDshBootstrap.parseProbe('DSHAPP alive 1\nDSHAPP url \n').reusable, isFalse);
    });

    test('foreign probe output: port, token and pid', () {
      final endpoint = RemoteDshBootstrap.parseForeignProbe('''
DSHAPP home /Users/me
DSHAPP found port=43210 pid=99
DSHAPP token foreign-tok
''');
      expect(endpoint, isNotNull);
      expect(endpoint!.port, 43210);
      expect(endpoint.token, 'foreign-tok');
      expect(endpoint.pid, 99);
      expect(endpoint.reused, isTrue);
      expect(endpoint.authority, '127.0.0.1:43210');
    });

    test('foreign probe output: nothing found, or no token, is null', () {
      expect(RemoteDshBootstrap.parseForeignProbe('DSHAPP none\n'), isNull);
      expect(RemoteDshBootstrap.parseForeignProbe('DSHAPP found port=1 pid=2\n'), isNull);
      expect(RemoteDshBootstrap.parseForeignProbe('DSHAPP token only\n'), isNull);
    });

    test('paths: ~ is expanded remotely and for session cwd', () {
      expect(RemoteDshBootstrap.remotePathExpr('~/code/my app'), '"\$HOME"/\'code/my app\'');
      expect(RemoteDshBootstrap.remotePathExpr("/srv/it's"), "'/srv/it'\\''s'");
      expect(RemoteDshBootstrap.absolutePath('~/code', '/home/me'), '/home/me/code');
      expect(RemoteDshBootstrap.absolutePath('~', '/home/me/'), '/home/me/');
      expect(RemoteDshBootstrap.absolutePath('/srv/x', '/home/me'), '/srv/x');
      expect(RemoteDshBootstrap.absolutePath('  ', '/home/me'), isNull);
    });

    test('shQuote survives quotes', () {
      expect(shQuote("a'b"), "'a'\\''b'");
      expect(loginShell('echo hi'), "printf '%s' ZWNobyBoaQ== | base64 -d | sh");
    });
  });

  group('scripts against /bin/sh', () {
    late Directory home;
    late Directory bin;
    late Map<String, String> env;

    setUp(() {
      home = Directory.systemTemp.createTempSync('dsh-app-remote-test-');
      bin = Directory('${home.path}/bin')..createSync();
      final tools = Directory('${home.path}/tools')..createSync();
      for (final tool in _tools) {
        final path = Process.runSync('sh', ['-c', 'command -v $tool']).stdout.toString().trim();
        if (path.isNotEmpty) Link('${tools.path}/$tool').createSync(path);
      }
      final dsh = File('${bin.path}/dsh')..writeAsStringSync(_fakeDsh);
      Process.runSync('chmod', ['+x', dsh.path]);
      env = {'HOME': home.path, 'PATH': '${bin.path}:${tools.path}'};
    });

    tearDown(() async {
      // Stop whatever the test started, then remove the temp HOME.
      final pidFile = File('${home.path}/.dsh-app-remote/web.pid');
      if (pidFile.existsSync()) {
        final pid = int.tryParse(pidFile.readAsStringSync().trim());
        if (pid != null) Process.killPid(pid);
      }
      try {
        home.deleteSync(recursive: true);
      } on FileSystemException {
        // A test process may still hold a file; the OS cleans the temp dir.
      }
    });

    RemoteDshBootstrap bootstrap(_RecordingShell shell, {Map<String, String> extra = const {}}) =>
        RemoteDshBootstrap(shell, environment: {...env, ...extra});

    Future<void> waitForArgsFile() async {
      for (var i = 0; i < 50; i++) {
        if (File('${home.path}/dsh-args.txt').existsSync()) return;
        await Future<void>.delayed(const Duration(milliseconds: 20));
      }
    }

    test('our recorded instance is reused without running a start script', () async {
      final hold = File('${home.path}/hold')..writeAsStringSync('#!/bin/sh\nsleep 30\n');
      Process.runSync('chmod', ['+x', hold.path]);
      final ours = await Process.start(hold.path, [
        'web',
        '--host',
        '127.0.0.1',
        '--port',
        '0',
        '--no-open',
      ]);
      addTearDown(ours.kill);
      final dir = Directory('${home.path}/.dsh-app-remote')..createSync();
      File('${dir.path}/web.pid').writeAsStringSync('${ours.pid}\n');
      File('${dir.path}/web.log').writeAsStringSync('dsh web: http://127.0.0.1:41234/?token=ours-tok\n');

      final shell = _RecordingShell(LocalProcessShell(environment: env));
      final endpoint = await bootstrap(shell).ensureAttached();

      expect(endpoint.reused, isTrue);
      expect(endpoint.port, 41234);
      expect(endpoint.token, 'ours-tok');
      expect(endpoint.pid, ours.pid);
      expect(endpoint.home, home.path);
      expect(shell.scripts.any((s) => s.contains('nohup')), isFalse);
      expect(File('${home.path}/dsh-args.txt').existsSync(), isFalse);
      expect(Process.runSync('kill', ['-0', '${ours.pid}']).exitCode, 0);
    });

    test('a dsh started elsewhere is reused with its port and fresh log token', () async {
      final foreign = await Process.start(
        '${bin.path}/dsh',
        ['web', '--host', '127.0.0.1', '--port', '43210', '--no-open'],
        environment: env,
      );
      addTearDown(foreign.kill);
      await waitForArgsFile();
      final logs = Directory('${home.path}/.dsh/logs')..createSync(recursive: true);
      File('${logs.path}/dsh-web-20261128.log').writeAsStringSync(
        'boot\n'
        'dsh web: http://127.0.0.1:43210/?token=foreign-tok\n',
      );

      final shell = _RecordingShell(LocalProcessShell(environment: env));
      final endpoint = await bootstrap(shell).ensureAttached();

      expect(endpoint.reused, isTrue);
      expect(endpoint.port, 43210);
      expect(endpoint.token, 'foreign-tok');
      expect(endpoint.pid, foreign.pid);
      expect(shell.scripts.any((s) => s.contains('nohup')), isFalse);
      // Only the foreign process's own argument record exists.
      expect(File('${home.path}/dsh-args.txt').readAsLinesSync(), hasLength(1));
    });

    test('nothing running: RemoteDshNotRunning and no start command', () async {
      final shell = _RecordingShell(LocalProcessShell(environment: env));
      await expectLater(
        bootstrap(shell).ensureAttached(),
        throwsA(
          isA<RemoteDshNotRunning>()
              .having((e) => e.port, 'port', defaultRemoteDshPort)
              .having((e) => e.message, 'message', contains('$defaultRemoteDshPort')),
        ),
      );
      expect(shell.scripts, isNotEmpty);
      for (final script in shell.scripts) {
        expect(script.contains('nohup'), isFalse, reason: 'no start script may run');
        expect(script.contains('DSHAPP started'), isFalse, reason: 'no start script may run');
      }
      // Nothing ever executed `dsh`, so it recorded no launch.
      expect(File('${home.path}/dsh-args.txt').existsSync(), isFalse);
    });

    test('a stale pid that is not ours is neither reused nor killed', () async {
      final other = await Process.start('sleep', ['30']);
      addTearDown(other.kill);
      final dir = Directory('${home.path}/.dsh-app-remote')..createSync();
      File('${dir.path}/web.pid').writeAsStringSync('${other.pid}\n');
      File('${dir.path}/web.log').writeAsStringSync('dsh web: http://127.0.0.1:1/?token=old\n');

      final probe = await bootstrap(_RecordingShell(LocalProcessShell(environment: env))).probe();
      expect(probe.pid, isNull);
      await expectLater(
        bootstrap(_RecordingShell(LocalProcessShell(environment: env))).ensureAttached(),
        throwsA(isA<RemoteDshNotRunning>()),
      );
      expect(Process.runSync('kill', ['-0', '${other.pid}']).exitCode, 0, reason: 'unrelated process survived');
    });

    for (final failingPs in [false, true]) {
      test('legacy node-like unrelated process survives (ps fails: $failingPs)', () async {
        final sleep = Process.runSync('sh', ['-c', 'command -v sleep']).stdout.toString().trim();
        final alias = Link('${bin.path}/node-unrelated')..createSync(sleep);
        final other = await Process.start(alias.path, ['30']);
        addTearDown(other.kill);
        if (failingPs) {
          final ps = File('${bin.path}/ps')..writeAsStringSync('#!/bin/sh\nexit 1\n');
          Process.runSync('chmod', ['+x', ps.path]);
        }
        final dir = Directory('${home.path}/.dsh-app-remote')..createSync();
        File('${dir.path}/web.pid').writeAsStringSync('${other.pid}\n');
        File('${dir.path}/web.log').writeAsStringSync('dsh web: http://127.0.0.1:1/?token=old\n');
        expect(File('${dir.path}/web.st').existsSync(), isFalse);
        final shell = _RecordingShell(LocalProcessShell(environment: env));
        await expectLater(bootstrap(shell).ensureAttached(), throwsA(isA<RemoteDshNotRunning>()));
        expect(shell.scripts.any((s) => s.contains('nohup')), isFalse);
        expect(
          Process.runSync('kill', ['-0', '${other.pid}']).exitCode,
          0,
          reason: 'unrelated node-like process survived',
        );
      });
    }

    test('environment overrides reach the scripts (live-test isolation)', () async {
      final alt = Directory('${home.path}/alt')..createSync();
      final hold = File('${home.path}/hold2')..writeAsStringSync('#!/bin/sh\nsleep 30\n');
      Process.runSync('chmod', ['+x', hold.path]);
      final ours = await Process.start(hold.path, [
        'web',
        '--host',
        '127.0.0.1',
        '--port',
        '0',
        '--no-open',
      ]);
      addTearDown(ours.kill);
      final dir = Directory('${alt.path}/.dsh-app-remote')..createSync();
      File('${dir.path}/web.pid').writeAsStringSync('${ours.pid}\n');
      File('${dir.path}/web.log').writeAsStringSync('dsh web: http://127.0.0.1:49001/?token=alt-tok\n');

      final b = RemoteDshBootstrap(
        LocalProcessShell(environment: env),
        environment: {'HOME': alt.path, 'bad name': 'x'},
      );
      final endpoint = await b.ensureAttached();
      expect(endpoint.home, alt.path);
      expect(endpoint.port, 49001);
      expect(endpoint.token, 'alt-tok');
      expect(File('${alt.path}/dsh-args.txt').existsSync(), isFalse);
    });
  });
}
