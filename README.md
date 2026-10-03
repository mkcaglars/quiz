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

**Akış ve otomatik bitiş**
1. Her soru kendi süresi dolunca kapanır (bağlı herkes cevapladıysa beklemeden kapanır).
2. Doğru cevap ve sıralama 5 sn gösterilir, ardından sonraki soruya otomatik geçilir.
3. Son soru bitince quiz otomatik biter. Toplam süre sınırı verildiyse süre dolduğunda quiz nerede olursa olsun biter.
4. Öğretmen her an "Bitir" ile sonlandırabilir.

Puanlama Kahoot gibidir: doğru cevap hıza göre 500–1000 puan, yanlış veya boş 0 puan.
Geç bağlanan ya da bağlantısı kopup geri gelen öğrenci devam eden soruya kaldığı yerden katılır (aynı isim = aynı oyuncu). Her derste aynı anda tek quiz çalışabilir; farklı dersler paralel çalışabilir.

## Veri

Quizler ve sonuçlar `data/quizzes.json` ve `data/results.json` dosyalarında tutulur (ilk çalıştırmada örnek bir Matematik quizi eklenir). Aktif quiz durumu bellektedir; sunucu yeniden başlarsa devam eden quiz kaybolur.

## Test

```bash
npm test
```
