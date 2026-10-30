# Mantar Dedektifi — Gemini sürümü

Mantar Dedektifi, iPhone Safari'de açılıp Ana Ekran'a eklenebilen Türkçe bir PWA'dır. Fotoğraflı ön inceleme Google Gemini API üzerinden sunucu tarafında yapılır.

## Özellikler

- Her analiz için en az 2, en fazla 5 farklı açı fotoğrafı zorunludur.
- iPhone fotoğrafları için JPG, PNG, WebP, HEIC ve HEIF desteği vardır.
- Üst, alt (lamel/gözenek), yan ve taban açıları için fotoğraf rehberi bulunur.
- Gemini birden fazla fotoğrafı tek istekte birlikte değerlendirir ve en fazla 3 olası türü Türkçe/Latince adlarıyla listeler.
- Görülebilen şapka, lamel/gözenek, sap, taban ve habitat ipuçları özetlenir.
- Yabani mantarlar için fotoğrafa dayalı yenilebilirlik onayı verilmez; sunucu her yanıtı `UNVERIFIED` ve `consumption_safe=false` olarak zorlar.
- Yabani mantarlara tarif üretilmez. Paketli kültür mantarı için arayüzde genel bir tarif gösterilir; bu tarif analiz sonucu veya güvenlik onayı değildir.
- GPS yalnızca kullanıcı Konum ekle düğmesine basınca alınır; fotoğraf analizine koordinat eklenmez.
- Fotoğraflar, analiz, tarih ve GPS konumu iPhone tarayıcısındaki IndexedDB'de saklanır.
- Keşif haritası, arşiv, arama, tür filtresi ve kayıt bazında konum paylaşımı vardır.
- Parola koruması ve IP bazlı giriş/analiz sınırları bulunur.

## Gemini yapılandırması

Google AI Studio'dan Gemini API anahtarı oluştur: https://aistudio.google.com/apikey

Daha önce sohbet içinde paylaşılan anahtarı kullanma. Paylaşılan anahtarı AI Studio'dan iptal et ve yeni bir anahtar oluştur. Anahtarı sohbet mesajına gönderme.

Sunucuda `.env.example` dosyasını `.env` adıyla kopyala ve aşağıdaki değişkenleri tanımla:

```env
GEMINI_API_KEY=YENI_GEMINI_ANAHTARINI_BURAYA
GEMINI_MODEL=gemini-3.8-flash
PORT=3000
SUPABASE_URL=https://PROJECT_REF.supabase.co
SUPABASE_ANON_KEY=SUPABASE_PUBLISHABLE_OR_ANON_KEY
# Supabase hesabı açıldığında APP_PASSWORD artık kullanılmaz; geçiş dönemi için tutulabilir.
APP_PASSWORD=eski-tek-parola-gecis-icin
```

`GEMINI_API_KEY` sadece Node.js sunucusunda okunur. Tarayıcıdaki HTML/JavaScript dosyalarına eklenmez. Sunucu, anahtarı Gemini isteğinde `x-goog-api-key` HTTP başlığıyla gönderir. Varsayılan model `gemini-3.8-flash` olarak ayarlanmıştır; model erişimi ve kota Google AI Studio hesabına bağlıdır.

## Windows 11'de yerel çalıştırma

Gereksinim: Node.js 20 veya daha yeni sürüm.

1. ZIP paketini bilgisayarına çıkar.
2. `.env.example` dosyasının kopyasını `.env` adıyla oluştur.
3. `.env` içine yeni Gemini anahtarını ve kendine ait güçlü `APP_PASSWORD` değerini gir.
4. PowerShell'i proje klasöründe aç.
5. Şunları çalıştır:

   ```powershell
   npm install
   npm start
   ```

6. Bilgisayarda `http://localhost:3000` adresini aç.
7. Sağlık kontrolü için `http://localhost:3000/api/health` adresini aç. `configured: true` ve `provider: "google-gemini"` görünmelidir.

Anahtar olmadan arayüz açılır ancak görsel analiz endpoint'i 503 döndürür. Gerçek Gemini görsel analizi için geçerli API anahtarı ve Gemini API erişimi gerekir.

## Çok kullanıcılı hesap sistemi (Supabase)

Hesap sistemi açılmadan önce:

1. Supabase'te bir proje oluştur.
2. Project URL ve publishable/anon public key değerlerini al. **service_role / secret key değerini tarayıcıya veya GitHub'a kesinlikle koyma.**
3. Supabase SQL Editor'de `supabase/migrations/20261031000100_multi_user_discoveries.sql` dosyasını çalıştır. Bu migration, kullanıcı kayıtlarını ve fotoğrafları `auth.uid()` ile sınırlar; fotoğraf deposu private olarak oluşturulur.
4. Authentication → URL Configuration bölümünde Site URL değerini canlı uygulamanın HTTPS adresi yap. Redirect URL listesine `https://mantar-1.onrender.com/**` ekle (kendi domainin değişirse onu da ekle).
5. Authentication → Providers → Email bölümünde e-posta girişini etkinleştir ve e-posta doğrulamasını açık tut. E-posta şablonları ve SMTP teslimatını gerçek kullanıcıya açmadan önce test et.
6. Render → Environment bölümüne `SUPABASE_URL` ve `SUPABASE_ANON_KEY` ekle. `SUPABASE_ANON_KEY` yalnızca Supabase'in publishable/anon public key değeridir; service_role değildir.
7. Yeni bir test hesabı oluştur. İki ayrı hesapla kayıtların, fotoğrafların ve konumların birbirinden ayrıldığını doğrulamadan herkese duyurma.

Kullanıcı keşifleri kendi cihazında IndexedDB'de saklanmaya devam eder; giriş yapan kişi isterse eski cihaz kayıtlarını hesabına taşır. Bulut arşivinde tablo RLS kuralları ve private fotoğraf deposu kullanıcı sahipliğini zorunlu kılar. Hesapla giriş yapıldığında analiz API'si de Supabase erişim token'ını sunucu tarafında doğrular.

E-posta doğrulama ve parola sıfırlama bağlantıları Supabase'in izin verilen redirect adreslerine bağlıdır. Supabase SMTP/teslimat ayarlarını yapmadan canlı kullanıcı kayıtlarını açma.

## TEMA'ya doğrudan fidan bağışı

Uygulama içindeki doğaya katkı bağlantısı kullanıcıyı doğrudan TEMA Vakfı'nın resmî fidan bağışı sayfasına yönlendirir. Uygulama bağış ödemesini işlemez, para tutmaz ve bağıştan komisyon almaz. Bağış tutarı, sertifika koşulları ve diğer seçenekler ödeme öncesi TEMA'nın kendi sayfasından kontrol edilmelidir.

## iPhone'a kurulum

Kamera, GPS ve PWA hizmet çalışanı için uygulama HTTPS üzerinden yayınlanmalıdır.

1. Projeyi özel bir GitHub deposuna yükle veya hosting sağlayıcısına güvenli biçimde aktar.
2. Render gibi Node.js destekleyen bir Web Service oluştur.
3. Build komutu `npm install`, Start komutu `npm start` olsun.
4. Hosting servisinin Environment Variables / Secrets bölümüne `GEMINI_API_KEY`, `GEMINI_MODEL` ve güçlü `APP_PASSWORD` ekle. API anahtarını GitHub'a ya da HTML/JS dosyalarına koyma.
5. HTTPS adresini iPhone Safari'de aç.
6. Safari Paylaş düğmesi → Ana Ekrana Ekle → Ekle.

Render için `render.yaml` örnek tanım içerir. Hosting ve API kullanımı sağlayıcıların ücret/kota koşullarına tabidir. Bu proje henüz internete dağıtılmış değildir; dağıtım için hosting hesabı ve ortam değişkenlerinin kullanıcı tarafından tanımlanması gerekir.

## Fotoğraf çekim önerisi

En iyi görsel inceleme için aynı örneği farklı açılardan çek:

1. Şapkanın üstten görünüşü.
2. Mantarın alt yüzeyi: lameller veya gözenekler.
3. Sapın yandan görünüşü.
4. Tabanı ve varsa kılıf/volva yapısı.
5. Mümkünse mantarın bulunduğu ortam ve yakınındaki ağaçlar.

Örnek üzerinde kesme, koparma veya tadına bakma yapma. Fotoğrafı çekerken mantarın tabanını ve çevresini ezmeden görünür kıl.

## Gizlilik ve veri saklama

- GPS koordinatı Gemini API isteğine gönderilmez.
- Fotoğraflar yalnızca analiz sırasında sunucuya iletilir; sunucu uygulama veritabanına fotoğraf arşivi yazmaz.
- Keşif kayıtları cihazdaki IndexedDB'de tutulur. Safari web sitesi verilerini silmek kayıtları silebilir.
- Otomatik bulut yedeklemesi veya cihazlar arası eşitleme yoktur.
- Harita görüntülenirken OpenStreetMap karo sunucusundan harita görselleri alınır.

## Mantar güvenliği

Bu uygulama bir mikolog, mantar uzmanı veya zehir danışma servisi değildir. Yapay zekâ, birden fazla fotoğrafa rağmen türü yanlış tanıyabilir. Benzer türler arasında ölümcül zehirli mantarlar bulunur. Uygulamadaki tür tahmini, güven düzeyi veya benzerlik açıklaması yenilebilirlik kanıtı değildir. Doğadan toplanan mantarı uygulama sonucuna dayanarak tüketme; yerinde uzman doğrulaması gerekir. Mantar yendi ve zehirlenme şüphesi oluştuysa 112'yi ara.

## Teknik notlar

- Backend: Node.js + Express + Multer.
- Vision: Gemini `generateContent` REST endpoint; bir istekte birden fazla `inline_data` görsel parçası.
- API key: sunucu ortam değişkeni `GEMINI_API_KEY`; tarayıcıya gönderilmez.
- Varsayılan model: `gemini-3.8-flash`.
- PWA kayıt/konum saklama: IndexedDB.
- Harita: Leaflet + OpenStreetMap.
