# Shadow Assistant — v1 plan

Tasarım kararları proje sahibinin kişisel notlarında tutulur; bu belge v1 uygulama planıdır.

**v1 hedefi:** Ana PC'de tarayıcıda ve telefonda aynı Jarvis benzeri arayüzle sesli ya da yazılı konuşmak, ev cihazlarını HA üzerinden kontrol etmek. Basit işler token harcamadan, gerisi uygun modelle.

**Kabul senaryoları (v1 bitti sayılır):**
1. Telefonda güç tuşuna basılı tut → "oturma odası ışığını kapat" → ışık kapanır, model çağrılmaz (katman 0).
2. Ana PC'de tarayıcıda "evde sıcaklık kaç?" → sesli Türkçe cevap (katman 1).
3. "Yatak odası ışığını kapat, hava temizleyiciyi gece moduna al, bilgisayarı aç" → çok adımlı iş (katman 2).
4. Onay isteyen bir işlem → hem sesle ("evet") hem ekrandaki düğmeyle onaylanabilir.
5. Evde Wi-Fi'da ve dışarıda Tailscale'de aynı uygulama çalışır.
6. Her model çağrısı model, token ve servisle kayda geçer.

## Mimari özeti (v1)

```
Android (Kotlin kabuk + WebView) ─┐
Ana PC tarayıcı ──────────────────┴─ WebSocket ─→ Core (TS, ana PC, Agent SDK)
                                                    ├─ router.yaml (katman 0/1/2)
                                                    ├─ izin kapısı (read/write/confirm)
                                                    ├─ services.yaml (servis kaydı)
                                                    ├─ MCP → HA MCP Server (Home Assistant, LAN)
                                                    ├─ HTTP → whisper-svc (ana PC GPU'su)
                                                    └─ HTTP → tts-svc / Piper (ana PC)
```

**Arayüz–uygulama sözleşmesi (karar: arayüz uygulamayla da çalışmalı):**
- Tek arayüz kodu (React + Vite + Three.js). Hem tarayıcıda hem Android WebView'ında aynı paket çalışır.
- Platforma özgü her şey bir **platform adaptörü** arkasında: mikrofon, ses çalma, TTS, titreşim, bildirim, token.
  - Web adaptörü: `getUserMedia`, Web Audio, tts-svc.
  - Android adaptörü: Kotlin `@JavascriptInterface` köprüsü; mikrofon ve TTS yerel.
  - Arayüz bileşenleri adaptöre doğrudan değil, ortak arayüze bağlanır.
- Önce mobil düzen: dar ekran, dokunmatik hedefler (≥ 44 px), dikey kullanım. Masaüstü genişletilmiş görünüm.
- 3D efektlerde kalite seviyeleri (yüksek/orta/düşük); telefonda varsayılan düşük, pil ve ısı için. Arka plandayken render durur.
- Tarayıcıya özgü API'lere doğrudan bağımlılık yok (Web Speech API, Picovoice wake word vb.). Jarvis'ten alınan parçalar buna göre ayıklanır.

## Görevler

Görev kutuları: `[ ]` başlanmadı, `[~]` başlandı, `[x]` bitti.

- **T0 — HA ön hazırlık** — Durum: Başlandı
  - [~] T0.1 — HA'da **MCP Server** entegrasyonunu kur; Shadow'a açılacak varlıkları seç (ışıklar, anahtarlar, hava temizleyici, sensörler; kamera ve modem kapalı)
  - [ ] T0.2 — Core için ayrı HA jetonu (`shadow-core`), env `HA_CORE_TOKEN`
  - [ ] T0.3 — HA'dan cevap süresini ve MCP araç listesini ölç (araç sayısı token maliyetini belirler)
- **T1 — Repo iskeleti** — Durum: Başlandı
  - [~] T1.1 — GitHub'da public `shadow-assistant` reposu; lisans MIT — yerel repo + LICENSE hazır; GitHub public repo açılması bekliyor
  - [x] T1.2 — Monorepo düzeni: `core/` (TS), `ui/` (React), `services/whisper-svc/` (Python), `services/tts-svc/`, `android/` (Kotlin), `deploy/`, `docs/`
  - [~] T1.3 — Gizli değer hijyeni: `.env.example`, `.gitignore`, gitleaks pre-commit, GitHub secret scanning + push protection; ev IP'leri ve host adları yalnız yerel config'te — yerel hijyen + gitleaks pre-commit hazır; GitHub secret scanning repo açılınca
  - [x] T1.4 — `THIRD_PARTY_NOTICES` (Jarvis MIT telif satırı)
  - [x] T1.5 — CI: lint + build (core, ui); Android build ayrı iş akışında
  - [x] T1.6 — Bu planı `docs/01-v1-plan.md` olarak taşı
- **T2 — Core v1** — Durum: Başlanmadı
  - [ ] T2.1 — Node + TS proje; Agent SDK, ana PC'deki Claude Code girişini kullanır
  - [ ] T2.2 — WebSocket API: metin gir/çık, akış (streaming), durum olayları (dinliyor/düşünüyor/konuşuyor), onay isteği/cevabı
  - [ ] T2.3 — `services.yaml` servis kaydı ve MCP bağlantıları (önce HA)
  - [ ] T2.4 — İzin kapısı: `read` serbest, `write` kayıtlı, `confirm` onay bekler (ses + düğme)
  - [ ] T2.5 — Cihaz başına token ile kimlik doğrulama (telefon, ana PC tarayıcısı)
  - [ ] T2.6 — Konuşma kayıtları vault altındaki gitignore'lu `.shadow-assistant/` klasörüne
  - [ ] T2.7 — Shadow bağlamı: sistem prompt'u + vault'tan seçili notları okuma aracı (tüm `~/.claude` ayarları yüklenmez)
- **T3 — Arayüz v1** — Durum: Başlanmadı
  - [ ] T3.1 — Jarvis'ten arayüz parçalarını al (MIT); tarayıcıya bağımlı parçaları ayıkla
  - [ ] T3.2 — Platform adaptörü ve web adaptörü
  - [ ] T3.3 — Önce mobil düzen; durumlar: boşta / dinliyor / düşünüyor / konuşuyor / onay bekliyor
  - [ ] T3.4 — Onay düğmesi, yazılı giriş, son konuşmalar
  - [ ] T3.5 — 3D kalite seviyeleri; telefonda düşük
- **T4 — whisper-svc** — Durum: Başlanmadı
  - [ ] T4.1 — `faster-whisper` large-v3, ana PC GPU'su; Docker GPU (WSL2) ya da yerel Python — ölçüp seç
  - [ ] T4.2 — HTTP uç noktası: ses parçası → Türkçe metin; gecikme hedefi < 1.5 sn (kısa komut)
  - [ ] T4.3 — `GET /health`, `services.yaml` kaydı
- **T5 — Ses çıkışı (TTS)** — Durum: Başlandı
  - [x] T5.1 — `tts-svc`: Piper Türkçe ses, ana PC
  - [ ] T5.2 — Android'de yerel TTS adaptörü (T6 ile)
  - [x] T5.3 — Ses seçimi: tts-svc Türkçe Piper sesleri (dfki varsayılan, fahrettin, fettah; ilk kullanımda indirilir), Core `voices`/`speak.voice`, arayüzde "Ses" seçici + "Dene"; telaffuz sözlüğü (`pronunciations.yaml`, ör. Shadow → Şadov)
- **T6 — Android kabuk** — Durum: Başlanmadı
  - [ ] T6.1 — Kotlin proje; WebView arayüzü yükler; JS köprüsü (mikrofon, TTS, titreşim, token)
  - [ ] T6.2 — Mikrofon kaydı → Core'a akış; uyandırma kelimesi yok
  - [ ] T6.3 — Varsayılan asistan rolü (`VoiceInteractionService`), güç tuşuyla açılış
  - [ ] T6.4 — Token Keystore'da; `network_security_config` yalnız ev LAN adresine cleartext
  - [ ] T6.5 — Evde LAN, dışarıda Tailscale ile aynı adres (ana PC'nin ev LAN adresi); bağlantı yoksa net hata ekranı
  - [ ] T6.6 — İmzalı APK CI'da üretilir, elle yüklenir (Play yok)
- **T7 — Yönlendirici ve token kaydı** — Durum: Başlanmadı
  - [ ] T7.1 — `router.yaml`: kalıp → servis/araç + katman + izin
  - [ ] T7.2 — Katman 0: HA'ya doğrudan çağrı, model yok
  - [ ] T7.3 — Katman 1 Haiku (sınıflandırma, kısa cevap) → gerekirse katman 2 Sonnet; Opus yalnız plan/derin analiz
  - [ ] T7.4 — Her çağrı için JSONL kayıt (model, token, servis, süre); mevcut token kullanım raporu ile birleşir
  - [ ] T7.5 — Prompt caching; araçlar ihtiyaç anında yüklenir
  - [ ] T7.6 — Hız A1, kalıcı oturum: cihaz başına tek uzun ömürlü SDK sorgusu (streaming input), katman değişimi `setModel()` ile, boşta kapanma, kullanım limiti hatası (`usage_limit`); hedef basit metin turu p50 ≤ 2,5 sn — tasarım ve görevler: `docs/07-speed.md` (A1; S1–S6, S12)
  - [ ] T7.7 — Hız A2, cümle cümle TTS: Core cevabı cümlelere böler, telaffuz sözlüğünü uygular, isteyen istemciye sıralı `speech_chunk` gönderir; arayüzde çalma kuyruğu; eski istemciler değişmez — `docs/07-speed.md` (A2; S9–S11)
  - [ ] T7.8 — Hız A3, katman-0 yönlendiricinin Türkçe düzeltmesi (ayrı geliştirici yürütüyor; `router-config.ts`, `turkish.ts`, `direct.ts`)
  - [ ] T7.9 — Hız A4, süreklilik: aynı cihaz 30 dk içinde (Core yeniden başlasa da) son konuşmasına devam eder; `sessions/devices.json` — `docs/07-speed.md` (A4; S3, S7, S8)
  - Not: model çağrıları Core'daki sağlayıcı arayüzünden geçer (`core/src/model-provider.ts`; Claude Agent SDK bir uygulama) — `docs/07-speed.md` §A1 Components. Sıradaki:
  - [ ] T7.y — Core MCP ağ geçidi (HA + vault araçları Core'un kendi MCP sunucusunda, izin/onay kapısı içeride, modeller HA kimlik bilgisi görmez)
  - [ ] T7.z — Yedek sağlayıcı (Claude limiti dolunca Codex, isteğe bağlı Ollama)
- **T8 — Çalıştırma (ana PC)** — Durum: Başlandı
  - [x] T8.1 — Core Windows'ta yerel Node servisi olarak (Claude Code girişi kullanıcı profilinde olduğu için Docker'da değil); açılışta başlar
  - [x] T8.2 — whisper-svc ve tts-svc Docker Desktop'ta, `deploy/` compose
  - [x] T8.3 — `.shadow-assistant/` klasörünün ana PC'den Drive'a şifreli yedeği (rclone) (isteğe bağlı günlük görev hariç)
  - [x] T8.4 — Sağlık kontrolü: servislerden biri düşerse arayüzde görünür
  - [x] T8.5 — Windows tepsi uygulaması (`deploy/windows/tray`, .NET 10): Core'u doğrudan node ile başlatır/denetler, durum simgesi, menü; logon görevi artık tepsi exe'sini çalıştırır
  - [x] T8.6 — Kaynak tasarrufu: whisper-svc boştayken modeli GPU'dan kaldırır (`WHISPER_IDLE_UNLOAD_MIN`, varsayılan 10) ve sağlık "idle" olarak sağlıklı görünür; tepsi "Oyun modu" whisper-svc'yi durdurur; arayüz mikrofon notu
  - [ ] T8.7 — Uyandırma sözcüğü ("Hey Shadow"/"Merhaba Shadow"), tepsiye gömülü openWakeWord
- **T9 — Uçtan uca doğrulama** — Durum: Başlanmadı
  - [ ] T9.1 — Kabul senaryoları 1–6, telefonda ve ana PC tarayıcısında
  - [ ] T9.2 — Türkçe tanıma ve ses kalitesi değerlendirmesi; gerekirse ElevenLabs kararı
- **T10 — Asistan hafızası** (tasarım: `docs/06-memory.md`; T7.6 kalıcı oturumun üstüne gelir) — Durum: Başlanmadı
  - [ ] T10.1 — Hafıza deposu: `memory/brief.md` (800 karakter bütçe), `memory/notes/<konu>.md`, `index.json`, `state.json`; atomik yazım, kilit (mutex), bütçe uyarıları (M1)
  - [ ] T10.2 — Filtreler: gizli değerler, kişisel numaralar, sağlık ayrıntıları, vault `Private/`, izin benzeri ve geçici bilgiler (M2)
  - [ ] T10.3 — Tur başına ilgili notları yükleme: anahtar kelime eşleşmesi, `<hafiza>` bloğu, sorgu başına bir kez (M3)
  - [ ] T10.4 — Otomatik çıkarım: boşta/N turda bir arka planda Haiku geçişi, birleştirme ve tekrar önleme, hız ve kullanım limiti sınırları (M4)
  - [ ] T10.5 — "Neyi hatırlıyorsun" / "bunu unut": `shadow-memory` araçları (`memory_list`, `memory_forget`) (M5)
  - [ ] T10.6 — Core bağlantısı: brief sistem prompt'unda, hafıza çerçeveleri, `features: ["memory"]` (M6)
  - [ ] T10.7 — Uzun oturumlarda bağlam sıkıştırma: eşik, önce çıkarım, `/compact` ya da özetle yeniden başlat (M7)
  - [ ] T10.8 — Arayüz: Ayarlar → Hafıza, listele ve sil (M8)
  - [ ] T10.9 — Belgeler ve uçtan uca doğrulama (M9)

**Sıra:** T0 ve T1 önce (paralel olabilir). T2–T5 T1'den sonra paralel; T6, T3'ün adaptör sözleşmesi (T3.2) netleşince başlar. T7, T2'nin üstüne gelir. T8–T9 en son. T7.6–T7.9 hız işi, görev sırası ve dosya sahipliğiyle `docs/07-speed.md`'de; T10 hafıza işi, T7.6'nın kalıcı oturumu ve ortak görevleri (S3, P1) bittikten sonra, `docs/06-memory.md`'deki sırayla.

## v2 (bu planın dışında, ertelendi)

- `health-svc` (Samsung Health → Health Connect → .NET + SQLite)
- `scheduler` (cron Python işleri) + MQTT (Mosquitto, Raspberry Pi)
- `media-svc` (YouTube PC/TV), `phone-svc` (alarm, Bluetooth/Shizuku, FCM)
- Google Calendar / Tasks, Routes API
- Proaktif bildirimler
- HA sıkılaştırma ayrı iş olarak yürür; v1'i beklemez.

## Açık sorular

- Arayüz paketi Core'dan mı yüklenir (her zaman güncel) yoksa APK içine mi gömülür (bağlantı yokken de açılır)? Öneri: Core'dan yükle, son sürümü önbellekte tut.
- Kullanım limiti: abonelik limitleri otomatik işlerde yetmezse API anahtarına geçiş eşiği (v2'de zamanlayıcıyla birlikte değerlendirilir).
