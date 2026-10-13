## <img src="assets/icon.svg" alt="Frame Capture Studio logosu" width="32" height="32" align="center"> Frame Capture Studio

Videolarınızdan tam çözünürlüklü durağan kareleri doğrudan tarayıcınızda çıkarın.

Frame Capture Studio, bir videodan tam istediğiniz anlarda kare alıp PNG veya JPG olarak dışa aktaran açık kaynaklı bir araçtır. İmleci başlamak istediğiniz yere koyarsınız, aralığı ve adedi seçersiniz, gerisini uygulama yapar.

Tüm işlemler tarayıcınızda yerel olarak gerçekleşir. Videonuz hiçbir sunucuya yüklenmez.

🌐 **Canlı Demo Bağlantısı :** https://aligokdam.github.io/frame.capture.studio/

---

## Özellikler

- 🎯 **Başlangıç:** Tüm video ya da zaman çizelgesindeki imleçten itibaren
- ⏱️ **Aralık:** 1 ile 5 saniye arasında bir kare
- 🔢 **Adet:** Manuel 1–5 kare ya da video sonuna kadar (tek seferde en fazla 1000)
- 🖼️ **Tam çözünürlük:** Kareler videonun kendi piksel boyutunda çizilir (4K → 4K)
- 💾 **Dışa aktarma:** PNG veya JPG, tek tek, ZIP olarak ya da doğrudan bir klasöre
- 📸 **Tek kare:** İmlecin altındaki kareyi anında al (`S` tuşu)
- 🎞️ Film şeridi önizlemeli zaman çizelgesi, alınacak karelerin işaretleri
- 🌍 24 dil (sağdan sola yazılan Arapça, Farsça ve Urduca dahil)
- 📱 Telefon, tablet ve bilgisayar, açık ve koyu tema
- 🔒 İçerik güvenlik politikası sayesinde sayfa hiçbir sunucuya veri gönderemez

---

## Nasıl Çalışır

1. Bir video seçin ya da sayfaya bırakın (MP4, MOV, WEBM, MKV, M4V).
2. **Tüm video** ya da **İmleçten** seçin, imleci zaman çizelgesinde sürükleyin.
3. Aralığı (1–5 sn) ve adedi (**Manuel** 1–5 / **Sonuna kadar**) belirleyin.
4. **Kare çıkar**'a basın, ardından PNG/JPG dosyalarını indirin ya da klasöre kaydedin.

---

## Proje Yapısı

Uygulama, [Cutout Effect Studio](https://github.com/aligokdam/cutout.github.io) ile aynı mimariyi kullanır: tek sayfa, ana sayfa, düzenleyici (`#/editor`) ve koşullar (`#/terms`) rotaları. Dil, gizlilik ve kılavuz için ortak açılır pencere, token tabanlı açık/koyu tema ve dil dosyaları. Derleme adımı ve bağımlılık yoktur.

```text
frame.capture.studio/
├── index.html              ana sayfa, düzenleyici ve koşullar
├── README.md
├── LICENSE                 MIT
└── assets/
    ├── icon.svg
    ├── css/app.css         tema token'ları ve tüm bileşenler
    ├── i18n/               24 dil dosyası (en, tr, de, fr, es, ar, zh, ja, …)
    └── js/
        ├── i18n.js         dil listesi
        ├── zip.js          bağımlılıksız ZIP yazıcı (stored, CRC32)
        ├── grabber.js      ekran dışı <video> ile kare yakalama
        ├── app.js          düzenleyici: durum, plan, zaman çizelgesi, dışa aktarma
        └── home.js         yönlendirme ve ana sayfa
```

### Kare doğruluğu

Kareler, önizlemeyi bozmamak için ikinci, ekran dışı bir `<video>` üzerinden alınır. Her konuma gidildikten sonra `requestVideoFrameCallback` ile karenin gerçekten sunulması beklenir, ardından kare videonun doğal boyutunda (`videoWidth × videoHeight`) bir canvas'a çizilip kodlanır.

### Yeni dil eklemek

`assets/i18n/en.js` dosyasını kopyalayıp çevirin ve kodunu `assets/js/i18n.js` içindeki listeye ekleyin.

---

## Tarayıcı notları

- Videonun açılabilmesi için tarayıcının onu oynatabilmesi gerekir. Bazı tarayıcılar MOV içindeki HEVC (H.265) videoları desteklemez.
- **Klasöre kaydet**, File System Access API gerektirir (Chrome, Edge ve diğer Chromium tarayıcılar). Diğerlerinde ZIP kullanılır.

---

## Lisans

MIT License

---

Created by **Ali Gökdam**
