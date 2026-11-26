// A plugin's card above the composer (docs/design/native-plugins-protocol.md
// `composer.banner`): two lines of text and up to two buttons — the cold-session
// hint (「本会话上下文 ≈ 105k token …」/「新开会话」「知道了」) is the first user.
// One card at a time; null data closes it. It sits above the status line and is
// folded away by the same rules.

import 'dart:async';

import 'package:dsh_client/dsh_client.dart' show DshGoScope;
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../plugins/native/native_icons.dart';
import '../../../plugins/native/native_model.dart';
import '../../../plugins/native/native_state.dart';
import '../../../plugins/native/native_surface.dart';
import '../../../state/plugins_state.dart';
import '../../pets/pet_perch.dart';
import '../../theme/theme.dart';
import '../plugin_widgets.dart' show PluginAvatar;
import 'native_taps.dart';
import 'native_tone.dart';
import 'rise_reveal.dart';

/// Banner geometry, shared with the geometry tests.
abstract final class BannerMetrics {
  /// Air inside the card.
  static const inset = 14.0;

  /// Between the text column and the primary button.
  static const gap = 10.0;

  /// Between the text lines, and above the secondary button.
  static const lineGap = 4.0;
  static const actionGap = 8.0;

  /// The primary button's height.
  static const button = 40.0;

  /// Between the card and what is under it (the strip's rhythm).
  static const below = 6.0;
}

/// One button of the card.
typedef BannerAction = ({String id, String label});

/// What [state] shows now: the plugin's data (`{text, note, icon, tone,
/// actions}`), cut to the documented limits; empty text means nothing to show.
({String text, String? note, String? icon, String? tone, List<BannerAction> actions}) nativeBannerCard(
  NativeSurfaceState state,
) {
  final data = state.data;
  final map = data is Map ? data : const {};
  String line(Object? value) => (value is String ? value : '').replaceAll(RegExp(r'\s+'), ' ').trim();

  String cut(String value, int max) {
    final runes = value.runes.toList();
    return runes.length <= max ? value : '${String.fromCharCodes(runes.take(max - 1))}…';
  }

  final text = cut(line(map['text']), NativeLimits.bannerTextMax);
  final note = cut(line(map['note']), NativeLimits.bannerNoteMax);
  final actions = <BannerAction>[];
  final raw = map['actions'];
  if (raw is List) {
    for (final item in raw) {
      if (actions.length >= NativeLimits.bannerActions) break;
      if (item is! Map) continue;
      final id = item['id'];
      final label = cut(line(item['label']), NativeLimits.bannerLabelMax);
      if (id is! String || id.isEmpty || label.isEmpty) continue;
      actions.add((id: id, label: label));
    }
  }
  return (
    text: text,
    note: note.isEmpty ? null : note,
    icon: map['icon'] is String ? map['icon'] as String : null,
    tone: map['tone'] is String ? map['tone'] as String : null,
    actions: actions,
  );
}

/// The card itself: the plugin's mark, its two lines, a primary button on the
/// right and a secondary one under the text.
class ComposerBanner extends StatelessWidget {
  const ComposerBanner({
    super.key,
    required this.package,
    required this.title,
    required this.text,
    this.note,
    this.icon,
    this.avatar,
    this.tone,
    required this.actions,
    this.onAction,
  });

  final String package;

  /// The plugin's name (read out, and the mark's letter).
  final String title;
  final String text;
  final String? note;

  /// An IconName; unknown or none draws the plugin's own avatar.
  final String? icon;

  /// The plugin bundle's own picture (a data: or https: image), if any.
  final String? avatar;

  /// `good` · `warn` · `bad` · `info` · `muted` (the default).
  final String? tone;
  final List<BannerAction> actions;
  final void Function(BannerAction action)? onAction;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final dsh = DshColors.of(context);
    final glyph = nativeIcon(icon);
    final accent = nativeToneColor(dsh, tone);
    final primary = actions.isNotEmpty ? actions.first : null;
    final secondary = actions.length > 1 ? actions[1] : null;
    const buttonStyle = ButtonStyle(
      minimumSize: WidgetStatePropertyAll(Size(0, BannerMetrics.button)),
      padding: WidgetStatePropertyAll(EdgeInsets.symmetric(horizontal: 16)),
      visualDensity: VisualDensity.compact,
      tapTargetSize: MaterialTapTargetSize.shrinkWrap,
    );
    return Semantics(
      liveRegion: true,
      label: [title, text, ?note].join(' '),
      excludeSemantics: true,
      child: GlassSurface(
        tier: GlassTier.card,
        child: Padding(
          padding: const EdgeInsets.all(BannerMetrics.inset),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Padding(
                    padding: const EdgeInsets.only(top: 2),
                    child: SizedBox.square(
                      key: const ValueKey('banner-mark'),
                      dimension: 20,
                      child: glyph != null
                          ? Icon(glyph, size: 16, color: accent ?? dsh.textTertiary)
                          : PluginAvatar(name: package, title: title, icon: avatar, size: 20),
                    ),
                  ),
                  const SizedBox(width: BannerMetrics.gap),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Text(
                          text,
                          maxLines: 3,
                          overflow: TextOverflow.ellipsis,
                          style: AppType.tabular(
                            theme.textTheme.bodyMedium!.copyWith(
                              color: theme.colorScheme.onSurface,
                              fontWeight: FontWeight.w500,
                              height: 1.35,
                            ),
                          ),
                        ),
                        if (note != null) ...[
                          const SizedBox(height: BannerMetrics.lineGap),
                          Text(
                            note!,
                            maxLines: 2,
                            overflow: TextOverflow.ellipsis,
                            style: theme.textTheme.bodySmall!.copyWith(
                              color: accent ?? dsh.textTertiary,
                              height: 1.3,
                            ),
                          ),
                        ],
                      ],
                    ),
                  ),
                  if (primary != null) ...[
                    const SizedBox(width: BannerMetrics.gap),
                    FilledButton(
                      key: const ValueKey('banner-primary'),
                      onPressed: onAction == null ? null : () => onAction!(primary),
                      style: buttonStyle,
                      child: Text(primary.label, maxLines: 1, overflow: TextOverflow.ellipsis),
                    ),
                  ],
                ],
              ),
              if (secondary != null) ...[
                const SizedBox(height: BannerMetrics.actionGap),
                OutlinedButton(
                  key: const ValueKey('banner-secondary'),
                  onPressed: onAction == null ? null : () => onAction!(secondary),
                  style: buttonStyle,
                  child: Text(secondary.label, maxLines: 1, overflow: TextOverflow.ellipsis),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

/// The card on the chat screen. [visible] false (a reply generating, read
/// only) sinks it; without a card it takes no room at all.
class ComposerBannerSlot extends ConsumerWidget {
  const ComposerBannerSlot({super.key, required this.sessionId, required this.visible});

  final String? sessionId;
  final bool visible;

  void _action(BuildContext context, WidgetRef ref, NativeBanner banner, BannerAction action) {
    unawaited(
      runNativeTap(
        context,
        ref,
        package: banner.package,
        surface: NativeSurface.composerBanner,
        id: banner.id,
        action: action.id,
        scope: DshGoScope(sessionId: sessionId),
      ),
    );
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final banner = ref.watch(nativeBannersProvider).firstOrNull;
    if (banner == null) return const SizedBox(width: double.infinity);
    final state = ref.watch(
      nativeSurfaceProvider(
        NativeSurfaceKey(
          package: banner.package,
          surface: NativeSurface.composerBanner,
          id: banner.id,
          scope: DshGoScope(sessionId: sessionId),
          live: banner.live,
        ),
      ),
    );
    final card = nativeBannerCard(state);
    final open = visible && card.text.isNotEmpty;
    final plugin = ref.watch(nativeContributionsProvider.select((c) => c.plugin(banner.package)));
    final bundle = ref.watch(
      installedPluginsProvider.select((s) => s.value?.where((b) => b.name == banner.package).firstOrNull),
    );
    return RiseReveal(
      open: open,
      child: open
          ? Padding(
              padding: const EdgeInsets.only(bottom: BannerMetrics.below),
              // The chat page's pet stands on the card while it is up.
              child: PetPerch(
                kind: PerchKind.plugin,
                active: true,
                child: ComposerBanner(
                  key: ValueKey('${banner.package}#${banner.id}'),
                  package: banner.package,
                  title: ref.watch(nativePluginTitleProvider(banner.package)),
                  icon: card.icon ?? plugin?.icon,
                  avatar: bundle?.meta?.icon,
                  tone: card.tone,
                  text: card.text,
                  note: card.note,
                  actions: card.actions,
                  onAction: card.actions.isEmpty ? null : (action) => _action(context, ref, banner, action),
                ),
              ),
            )
          : const SizedBox(width: double.infinity),
    );
  }
}
