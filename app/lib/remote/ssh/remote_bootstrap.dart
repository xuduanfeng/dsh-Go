import 'package:dsh_client/dsh_client.dart';

import '../../l10n/l10n.dart';
import '../link_status.dart';
import 'remote_shell.dart';

/// dsh-app's state directory on the remote (pid, log, launch command).
const remoteStateDir = r'$HOME/.dsh-app-remote';

/// Port dsh-Go tells people to start `dsh web` on when nothing is listening.
const defaultRemoteDshPort = 3080;

/// Marker that prefixes every structured line our scripts print, so login
/// banners and `~/.profile` chatter can't be mistaken for results.
const _tag = 'DSHAPP';

/// A `dsh web` on the remote that dsh-app can reach through a tunnel.
class RemoteDshEndpoint {
  const RemoteDshEndpoint({
    required this.port,
    required this.token,
    this.pid,
    this.reused = false,
    this.home,
  });

  /// Port on the remote's loopback (`--host 127.0.0.1`).
  final int port;

  /// Launch token from the `dsh web: http://…/?token=` line; good for this
  /// process's lifetime only.
  final String token;
  final int? pid;

  /// A live instance was found and reused instead of being started.
  final bool reused;

  /// Remote `$HOME`, to expand `~` in the configured working directory.
  final String? home;

  /// `127.0.0.1:<port>`: the Host header DSH's fence accepts.
  String get authority => '127.0.0.1:$port';
}

/// Nothing on the remote is reachable as `dsh web`; dsh-Go never starts one.
class RemoteDshNotRunning implements Exception {
  const RemoteDshNotRunning({required this.port, this.detail});

  /// Port the person is told to start `dsh web` on (usually 3080).
  final int port;

  /// Extra context from the probe (never a launch suggestion).
  final String? detail;

  String get message => appL10n.remoteErrDshNotRunning(port);

  @override
  String toString() => detail == null ? message : '$message ($detail)';
}

/// What the probe found on the remote.
class RemoteProbe {
  const RemoteProbe({this.home, this.pid, this.launchLine});

  final String? home;

  /// Pid of the instance dsh-app started earlier, if it's still alive.
  final int? pid;

  /// Latest `dsh web: http://…?token=` line from its log.
  final String? launchLine;

  bool get reusable => pid != null && DshLaunchUrl.tryParse(launchLine ?? '') != null;
}

/// Finds a running `dsh web` on the remote; it never starts, stops or restarts
/// one.
///
/// Files under `~/.dsh-app-remote/` (mode 700) are only read:
/// * `web.pid` — pid of the `dsh web` process that instance recorded (a pid
///   that is no longer that process is discarded, never signalled);
/// * `web.log` — its stdout/stderr, where the `token=` launch line lives.
///
/// Two sources are consulted, in order:
/// 1. the instance recorded in `~/.dsh-app-remote/` (fast path, pid and log);
/// 2. any other live `dsh web --port …` process, whose token is recovered
///    from `~/.dsh/logs/dsh-web-*.log` (see [foreignProbeScript]).
///
/// If neither yields a token, [ensureAttached] throws [RemoteDshNotRunning].
/// Reusing an existing server instead of starting a second one avoids the
/// orphaned processes and double-written sessions a random `--port 0` left
/// behind.
class RemoteDshBootstrap {
  RemoteDshBootstrap(
    this.shell, {
    this.environment = const {},
    this.defaultPort = defaultRemoteDshPort,
  });

  final RemoteShell shell;

  /// Extra variables exported before anything runs (tests isolate `HOME` and
  /// `DSH_HOME` this way; advanced users could add PATH tweaks).
  final Map<String, String> environment;

  /// Port named in [RemoteDshNotRunning.message].
  final int defaultPort;

  /// Reuses the instance dsh-app recorded, else adopts any other live `dsh web`
  /// it can read a token for. Never calls a start command.
  /// [onDetail] receives short progress notes for the UI.
  Future<RemoteDshEndpoint> ensureAttached({void Function(String)? onDetail}) async {
    final probe = await this.probe();
    if (probe.reusable) {
      final url = DshLaunchUrl.tryParse(probe.launchLine!)!;
      onDetail?.call(appL10n.remoteBootstrapReusePort(url.baseUri.port));
      return RemoteDshEndpoint(
        port: url.baseUri.port,
        token: url.token,
        pid: probe.pid,
        reused: true,
        home: probe.home,
      );
    }
    final result = await shell.run(foreignProbeScript(), timeout: const Duration(seconds: 20));
    if (_missingShell(result)) throw _noShell(result);
    final found = parseForeignProbe(result.stdout, home: probe.home);
    if (found == null) {
      final stderr = result.stderr.trim();
      throw RemoteDshNotRunning(
        port: defaultPort,
        detail: stderr.isEmpty ? null : redactTokens(stderr.split('\n').take(4).join('\n')),
      );
    }
    onDetail?.call(appL10n.remoteBootstrapReusePort(found.port));
    return found;
  }

  Future<RemoteProbe> probe() async {
    final result = await shell.run(probeScript(), timeout: const Duration(seconds: 20));
    if (_missingShell(result)) throw _noShell(result);
    return parseProbe(result.stdout);
  }

  // ---------------------------------------------------------------------------
  // Scripts (POSIX sh; also tested against the local /bin/sh).

  String _prelude() {
    final b = StringBuffer()..writeln('umask 077');
    for (final entry in environment.entries) {
      if (!RegExp(r'^[A-Za-z_][A-Za-z0-9_]*$').hasMatch(entry.key)) continue;
      b.writeln('${entry.key}=${shQuote(entry.value)}; export ${entry.key}');
    }
    b
      ..writeln('D="$remoteStateDir"')
      // A PID can be recycled after reboot; bind ownership to its start time.
      ..writeln(r"""
_st() {
  if [ -r "/proc/$1/stat" ]; then
    S=$(cat "/proc/$1/stat" 2>/dev/null) || return 1
    S=${S##*) }
    set -- $S
    [ "$#" -ge 20 ] || return 1
    shift 19
    printf '%s\n' "$1"
  else
    ps -p "$1" -o lstart= 2>/dev/null
  fi
}
ours() {
  kill -0 "$1" 2>/dev/null || return 1
  if [ -f "$D/web.st" ]; then
    A=$(_st "$1") || return 1
    B=$(cat "$D/web.st" 2>/dev/null) || return 1
    [ -n "$A" ] && [ -n "$B" ] && [ "$A" = "$B" ]
    return $?
  fi
  A=$(ps -p "$1" -o args= 2>/dev/null) || return 1
  case "$A" in
    *'--host 127.0.0.1 --port 0 --no-open'*) return 0;;
    *) return 1;;
  esac
}
""");
    return b.toString();
  }

  String probeScript() {
    return '${_prelude()}'
        'printf \'$_tag home %s\\n\' "\$HOME"\n'
        'if [ -f "\$D/web.pid" ]; then\n'
        '  P=\$(cat "\$D/web.pid" 2>/dev/null)\n'
        '  if [ -n "\$P" ] && ours "\$P"; then\n'
        '    printf \'$_tag alive %s\\n\' "\$P"\n'
        '    L=\$(grep -E \'https?://[^ ]*[?&]token=\' "\$D/web.log" 2>/dev/null | tail -n 1)\n'
        '    printf \'$_tag url %s\\n\' "\$L"\n'
        '  else\n'
        '    rm -f "\$D/web.pid"\n'
        '  fi\n'
        'fi\n'
        'true\n';
  }

  /// Adopts an existing `dsh web` started outside dsh-Go.
  ///
  /// Candidates come from `ps -A -o pid= -o args=`: the command line must
  /// mention `dsh`, ` web` and `--port`. Our own recorded pid is skipped. The
  /// port comes from `--port <n>` / `--port=<n>`; `0` falls back to the launch
  /// URL in the newest log. A token is accepted only when the log was written
  /// at or after the process started minus two minutes, so a previous process's
  /// token can't be mistaken for this one's.
  String foreignProbeScript() => '${_prelude()}$_foreignProbeScript';

  // ---------------------------------------------------------------------------
  // Parsing (static: unit-tested without a shell).

  static Iterable<(String, String)> _tagged(String stdout) sync* {
    for (final raw in stdout.split('\n')) {
      final line = raw.trimRight();
      if (!line.startsWith('$_tag ')) continue;
      final rest = line.substring(_tag.length + 1);
      final space = rest.indexOf(' ');
      yield space < 0 ? (rest, '') : (rest.substring(0, space), rest.substring(space + 1));
    }
  }

  static RemoteProbe parseProbe(String stdout) {
    String? home;
    int? pid;
    String? url;
    for (final (key, value) in _tagged(stdout)) {
      switch (key) {
        case 'home':
          home = value.isEmpty ? null : value;
        case 'alive':
          pid = int.tryParse(value.trim());
        case 'url':
          url = value.trim().isEmpty ? null : value.trim();
      }
    }
    return RemoteProbe(home: home, pid: pid, launchLine: url);
  }

  static RemoteDshEndpoint? parseForeignProbe(String stdout, {String? home}) {
    int? port;
    int? pid;
    String? token;
    for (final (key, value) in _tagged(stdout)) {
      switch (key) {
        case 'found':
          for (final part in value.split(' ')) {
            final eq = part.indexOf('=');
            if (eq < 0) continue;
            final name = part.substring(0, eq);
            final parsed = int.tryParse(part.substring(eq + 1));
            if (name == 'port') port = parsed;
            if (name == 'pid') pid = parsed;
          }
        case 'token':
          token = value.trim();
      }
    }
    if (port == null || token == null || token.isEmpty) return null;
    return RemoteDshEndpoint(port: port, token: token, pid: pid, reused: true, home: home);
  }

  static bool _missingShell(RemoteExecResult result) =>
      !result.stdout.contains(_tag) &&
      RegExp(r"'sh' is not recognized|sh: (command )?not found|command not found: sh|No such file or directory.*\bsh\b")
          .hasMatch(result.stderr);

  static HostLinkError _noShell(RemoteExecResult result) =>
      HostLinkError(HostLinkErrorKind.noShell, appL10n.remoteErrNoShell, detail: result.stderr.trim());

  /// `token=…` values replaced, so a log tail can be shown or copied safely.
  static String redactTokens(String text) => redactRemoteTokens(text);

  /// Shell expression for a remote path with `~` expanded by the remote shell.
  static String remotePathExpr(String path) {
    final p = path.trim();
    if (p == '~') return '"\$HOME"';
    if (p.startsWith('~/')) return '"\$HOME"/${shQuote(p.substring(2))}';
    return shQuote(p);
  }

  /// [path] with `~` resolved against the remote [home] (for `session/create`).
  static String? absolutePath(String? path, String? home) {
    final p = path?.trim();
    if (p == null || p.isEmpty) return null;
    if (home == null || home.isEmpty) return p;
    if (p == '~') return home;
    if (p.startsWith('~/')) {
      return '${home.endsWith('/') ? home.substring(0, home.length - 1) : home}/${p.substring(2)}';
    }
    return p;
  }
}

/// POSIX sh body appended to [RemoteDshBootstrap.foreignProbeScript] output.
const _foreignProbeScript = r'''
printf 'DSHAPP home %s\n' "$HOME"
MY=$(cat "$D/web.pid" 2>/dev/null)
_start_epoch() {
  if [ -r "/proc/$1/stat" ] && [ -r /proc/uptime ]; then
    S=$(cat "/proc/$1/stat" 2>/dev/null) || return 1
    S=${S##*) }
    set -- $S
    [ "$#" -ge 20 ] || return 1
    shift 19
    J=$1
    U=$(cut -d' ' -f1 /proc/uptime 2>/dev/null) || return 1
    H=$(getconf CLK_TCK 2>/dev/null)
    [ -n "$H" ] || H=100
    printf '%s\n' $(( $(date +%s) - ${U%.*} + J / H ))
  else
    L=$(ps -p "$1" -o lstart= 2>/dev/null | tr -s ' ' | sed 's/^ *//')
    [ -n "$L" ] || return 1
    date -j -f '%a %b %d %T %Y' "$L" +%s 2>/dev/null || date -d "$L" +%s 2>/dev/null
  fi
}
_log_mtime() {
  stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null
}
MATCH=$(ps -A -o pid= -o args= 2>/dev/null | while read -r P A; do
  [ -n "$P" ] || continue
  [ "$P" = "$MY" ] && continue
  case " $A " in
    *dsh*" web"*--port*) ;;
    *) continue;;
  esac
  case " $A " in
    *" --port="*) PORT=${A#*--port=}; PORT=${PORT%% *};;
    *" --port "*) PORT=${A#* --port }; PORT=${PORT%% *};;
    *) continue;;
  esac
  case "$PORT" in ''|*[!0-9]*) continue;; esac
  START=$(_start_epoch "$P") || continue
  case "$START" in ''|*[!0-9]*) continue;; esac
  CUT=$((START - 120))
  LOGS=$(ls -t "$HOME"/.dsh/logs/dsh-web-*.log 2>/dev/null)
  for L in $LOGS; do
    M=$(_log_mtime "$L") || continue
    case "$M" in ''|*[!0-9]*) continue;; esac
    [ "$M" -ge "$CUT" ] || continue
    if [ "$PORT" -gt 0 ]; then
      U=$(grep -Eo "http://127\.0\.0\.1:$PORT/\?token=[^ ]*" "$L" 2>/dev/null | tail -n 1)
    else
      U=$(grep -Eo 'http://127\.0\.0\.1:[0-9]+/\?token=[^ ]*' "$L" 2>/dev/null | tail -n 1)
      if [ -n "$U" ]; then
        PORT=${U#http://127.0.0.1:}
        PORT=${PORT%%/*}
      fi
    fi
    [ -n "$U" ] || continue
    T=${U#*token=}
    T=${T%%&*}
    printf 'DSHAPP found port=%s pid=%s\n' "$PORT" "$P"
    printf 'DSHAPP token %s\n' "$T"
    exit 0
  done
done)
if [ -n "$MATCH" ]; then
  printf '%s\n' "$MATCH"
  exit 0
fi
printf 'DSHAPP none\n'
exit 0
''';
