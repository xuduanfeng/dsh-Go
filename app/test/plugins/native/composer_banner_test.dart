import 'package:dsh_app/plugins/native/native_model.dart';
import 'package:dsh_app/plugins/native/native_surface.dart';
import 'package:dsh_app/ui/plugins/native/composer_banner.dart';
import 'package:flutter_test/flutter_test.dart';

NativeSurfaceState _state(Object? data) => NativeSurfaceState(loading: false, data: data);

void main() {
  test('a card keeps its two lines and its buttons, in order', () {
    final card = nativeBannerCard(
      _state({
        'text': '  本会话上下文 ≈ 105k token · 刚刚还在用 · 若缓存失效约 0.11 元 ',
        'note': '新开约 <0.01 元 · 空闲价',
        'icon': 'wallet',
        'tone': 'muted',
        'actions': [
          {'id': 'open', 'label': '新开会话'},
          {'id': 'dismiss', 'label': '知道了'},
        ],
      }),
    );
    expect(card.text, '本会话上下文 ≈ 105k token · 刚刚还在用 · 若缓存失效约 0.11 元');
    expect(card.note, '新开约 <0.01 元 · 空闲价');
    expect(card.icon, 'wallet');
    expect(card.tone, 'muted');
    expect(card.actions.map((a) => a.id), ['open', 'dismiss']);
    expect(card.actions.map((a) => a.label), ['新开会话', '知道了']);
  });

  test('no data, or blank text, is no card', () {
    expect(nativeBannerCard(const NativeSurfaceState()).text, isEmpty);
    expect(nativeBannerCard(_state(null)).text, isEmpty);
    expect(nativeBannerCard(_state({'text': '   '})).text, isEmpty);
  });

  test('the app keeps the bridge limits: 120 + 90 characters, 8 + 2 buttons', () {
    final long = 'x' * 400;
    final card = nativeBannerCard(
      _state({
        'text': long,
        'note': long,
        'actions': [
          {'id': 'a', 'label': '12345678901234'},
          {'id': 'b', 'label': 'B'},
          {'id': 'c', 'label': 'C'},
          {'id': '!bad id', 'label': 'D'},
        ],
      }),
    );
    expect(card.text.runes.length, NativeLimits.bannerTextMax);
    expect(card.text, endsWith('…'));
    expect(card.note!.runes.length, NativeLimits.bannerNoteMax);
    expect(card.actions.length, 2);
    expect(card.actions.first.label, '1234567…');
  });
}
