# Quiz: Kahoot tarzı eş zamanlı sınıf quizi

Öğretmen ve öğrenci tarafı olan, gerçek zamanlı (Socket.IO) çalışan bir quiz uygulaması.

## Kurulum ve çalıştırma

```bash
npm install
TEACHER_PASSWORD=gizliSifre npm start     # varsayılan port 3000 (PORT ile değiştirilebilir)
```

| Sayfa | Adres |
|---|---|
| Öğretmen paneli | `http://localhost:3000/ogretmen` |
| Öğrenci | `http://localhost:3000/?isim=Ali%20Yılmaz&ders=Matematik` |

`TEACHER_PASSWORD` verilmezse şifre `ogretmen123` olur. Gerçek kullanımda mutlaka değiştirin.

## Nasıl çalışır?

**Öğrenci:** İsim ve ders URL'den gelir (`isim`/`ad`/`name` ve `ders`/`lesson`/`course` parametreleri kabul edilir). Öğrenci o dersin bekleme salonuna düşer ve o derse ait quizlerin listesini "Kapalı" olarak görür. Parametreler eksikse küçük bir giriş formu gösterilir. Ders adı büyük/küçük harf ve boşluk duyarsızdır (`matematik` = `Matematik`).

**Öğretmen:** Şifre ile giriş yapar.
- *Quizler* sekmesi: quiz oluşturma, düzenleme, kopyalama, silme. Her soruda 2–4 seçenek, doğru cevap ve soru süresi (5–300 sn) vardır. İsteğe bağlı olarak quizin toplam süre sınırı (dakika) verilebilir.
- *Canlı* sekmesi: hangi derste hangi öğrencilerin bağlı olduğunu görür ve o dersin quizini **başlatır**. Başlatınca o dersteki tüm öğrencilerde quiz **aynı anda** açılır (3 sn geri sayım). Canlı ekranda soru, kalan süre, seçenek dağılımı, kaç kişinin cevapladığı ve sıralama görünür. "Cevabı göster / Sonraki" ile akışı hızlandırabilir, **Bitir** ile quizi istediği an sonlandırabilir.
- *Sonuçlar* sekmesi: biten quizlerin öğrenci bazlı detayları ve CSV (Excel uyumlu) indirme.

**Quiz yükleme (Excel/CSV):** *Quizler* sekmesindeki **Quiz yükle** bölümünden şablon indirilir ([`public/sablon.csv`](public/sablon.csv)), Excel'de doldurulup geri yüklenir. Her satır bir sorudur; aynı Ders + Quiz Başlığı'na sahip satırlar tek quiz olur, böylece bir dosyada birden fazla quiz olabilir.

| Sütun | Açıklama |
|---|---|
| Ders | Öğrenci bağlantısındaki `ders` ile aynı olmalı. Boşsa üstteki satırınki kullanılır. |
| Quiz Başlığı | Boşsa üstteki satırınki kullanılır. |
| Soru | Soru metni |
| Seçenek A–D | A ve B zorunlu, C ve D isteğe bağlı |
| Doğru Cevap | A, B, C veya D |
| Süre (sn) | 5–300, boşsa 20 |
| Toplam Süre (dk) | İsteğe bağlı quiz süre sınırı (0/boş = yok) |

Yüklemeden önce önizleme gösterilir; hatalı satırlar satır numarasıyla listelenir ve düzeltilmeden içe aktarılmaz. Aynı ders ve başlıkta quiz varsa güncellenir, yoksa yeni eklenir. Her quizin yanındaki **İndir** düğmesi quizi aynı şablon biçiminde verir; düzenleyip tekrar yükleyebilirsiniz. UTF-8 ve Türkçe Windows (Excel'in normal "CSV") kodlamaları, `;` `,` ve sekme ayraçları desteklenir; JSON dosyaları da yüklenebilir.

**Akış ve otomatik bitiş**
1. Her soru kendi süresi dolunca kapanır (bağlı herkes cevapladıysa beklemeden kapanır).
2. Doğru cevap ve sıralama 5 sn gösterilir, ardından sonraki soruya otomatik geçilir.
3. Son soru bitince quiz otomatik biter. Toplam süre sınırı verildiyse süre dolduğunda quiz nerede olursa olsun biter.
4. Öğretmen her an "Bitir" ile sonlandırabilir.
5. Quiz bitince öğretmen ekranında skor tablosu açılır: ilk 3 öğrenci altın, gümüş ve bronz madalyalı kürsüde, diğerleri altta sıralı. Tablo öğretmen **Kapat** diyene kadar (sayfa yenilense bile) ekranda kalır; **Tam ekran** ile tahtaya yansıtılabilir. *Sonuçlar* sekmesinden tekrar açılabilir.

Puanlama Kahoot gibidir: doğru cevap hıza göre 500–1000 puan, yanlış veya boş 0 puan.
Geç bağlanan ya da bağlantısı kopup geri gelen öğrenci devam eden soruya kaldığı yerden katılır (aynı isim = aynı oyuncu). Her derste aynı anda tek quiz çalışabilir; farklı dersler paralel çalışabilir.

## Veri ve veritabanı

Quizler ve biten quizlerin sonuçları kalıcı olarak saklanır. Sonuçları sadece öğretmen (şifreyle) görür.

- **`DATABASE_URL` tanımlıysa** kayıtlar PostgreSQL'e yazılır. Tablolar ilk açılışta otomatik oluşturulur. `data/` klasöründe eski JSON kayıtları varsa veritabanı boşken bir kez içeri aktarılır.
- **Tanımlı değilse** kayıtlar `data/quizzes.json` ve `data/results.json` dosyalarına yazılır (yerel deneme için).

İlk çalıştırmada örnek bir Matematik quizi eklenir. Devam eden quizin anlık durumu bellektedir; sunucu ders sırasında yeniden başlarsa o quiz yarıda kalır, ama kayıtlı quizler ve sonuçlar silinmez.

### Render + Neon ile yayınlama

1. https://neon.tech adresinde ücretsiz hesap açıp bir proje oluşturun (bölge: Frankfurt) ve bağlantı adresini kopyalayın (`postgresql://...neon.tech/neondb?sslmode=require`).
2. https://render.com adresinde **New → Web Service** ile bu repoyu seçin. Build: `npm install`, Start: `npm start`, plan: Free.
3. **Environment** bölümüne iki değişken ekleyin: `TEACHER_PASSWORD` (öğretmen şifresi) ve `DATABASE_URL` (Neon adresi).

Ücretsiz Render sunucusu 15 dakika kullanılmazsa uyur; ilk açılış 30–60 sn sürer. Dersten önce öğretmen panelini açmanız yeterli.

## Test

```bash
npm test                                                        # JSON dosya modu
TEST_DATABASE_URL=postgresql://kullanici@localhost/quiztest npm test   # PostgreSQL modu (tabloları siler!)
```
