# Junction

Editörünüzü yerel yapay zeka kodlama agentlarına bağlayan bir VS Code sohbet paneli.

`7 arka uç` · `Sohbet paneli` · `Çalışma alanı bağlamı` · `Animasyonlu açılış ekranı` · `MIT Lisansı`

![İki tanıdık tema](../media/two_familiar_skins.png)

Junction, VS Code için yerel yapay zeka kodlama agentlarına bağlanan bir sohbet panelidir.
Birden fazla arka uç agentıyla tek birleşik bir arayüz üzerinden iletişim kurar — iş akışınızı değiştirmeden arasında geçiş yapın.

## Desteklenen Arka Uçlar

Junction şu yerel agent çalışma zamanlarına bağlanabilir:

- **OpenClaw** — oturum ve model yönetimi ile WebSocket ağ geçidi entegrasyonu
- **Hermes** — yerel panosu WebSocket ve REST API desteği
- **Souveraine** — yönetilen çalışma zamanı başlatma ile HTTP sunucu entegrasyonu
- **MiMoCode** — otomatik başlatılan veya önceden yapılandırılmış MiMo sunucu bağlantısı
- **Goose** — veri dizini ve gizli anahtar yapılandırması
- **OpenCode** — ikili dosya yolu ve yapılandırma dizini ayarları
- **OpenHands** — sunucu başlatıcı ve ana dizin yapılandırması

## Özellikler

### Sohbet Paneli
VS Code'un ikincil panelinden aktif agentınızla konuşun. Komut Paleti ile açın: `Junction: Open Sidebar`.

### Çalışma Alanı Bağlamı
Dosyaları sohbet giriş alanına sürükleyip bırakın veya bir dosyaya ya da seçime sağ tıklayarak geçici konuya ekleyin.

### Model ve Akıl Yürütme Seçici
Panel başlığından oturum başına bir model seçin ve akıl yürütme çabasını ayarlayın.

### Markdown Gösterimi
Agent yanıtları, araç çağrı kartları, akıl yürütme blokları ve farklar satır içi söz dizimi vurgulamasıyla gösterilir.

### Sohbet Düzenleri
Kompakt mod (etkinlik akordeonlarda toplanmış) ve zaman çizelgesi modu (kronolojik akıl yürütme akışı, sabitlenmiş kullanıcı iletileri) arasında geçiş yapın.

### Takip Modları
Agent işlemi bitince iletileri kuyruğa alın, işlem sırasında yönlendirin veya kesip yeniden yönlendirin. Köprü başına veya genel olarak yapılandırılabilir.

### Otomatik Yeniden Bağlanma
Bağlantı kesilirse Junction otomatik olarak yeniden bağlanır. Manuel yeniden başlatma gerekmez.

## Temalar

Junction yerleşik iki düzen içerir. **Kompakt** mod, etkinliği özet akordeonlarında toplayarak yoğun bir görünüm sağlar.
**Zaman çizelgesi** modu, nokta göstergeleri, akıl yürütme açılımı ve turuncu vurgu temasıyla kronolojik bir etkinlik rayı gösterir.
Her iki düzen de VS Code renk temanıza uyum sağlar.

## Açılış Ekranı ve Animasyonlar

Junction, amblemin arkasında matrix tarzı bir yağmur efekti içeren animasyonlu bir açılış ekranı ile açılır.
Açılış ekranı, editör içi animasyon ayarları paneli aracılığıyla tamamen özelleştirilebilir.

### Karakter Kümeleri
Yağmur efekti 10 karakter kümesini destekler: Katakana, Matrix Latin, Latin, Hiragana, CJK, Hangeul, Emoji, İkili, Semboller ve Özel.
Yapılandırılabilir nadirlikte emoji damlaları karıştırın veya kendi karakter kümenizi sağlayın.

### Yağmur Kontrolleri
- **Yön** — yağmurun yukarı veya aşağı yağmasını değiştirin
- **Ters yön şansı** — damlaların ters yöne gitme yüzdesini ayarlayın
- **Kenarlardan sekme** — yağmur ekranın dışına düşmek yerine sol/sağ kenarlardan seker
- **Yerçekimi, sekme, çarpışma, hız** — damlaların nasıl hareket ettiğini ve amblemle nasıl etkileşime girdiğini ayarlayın
- **Miktar, boyut varyansı, renk varyansı, opaklık aralığı** — yağmurun yoğunluğunu ve görünümünü kontrol edin
- **Özel renk** — yağmur ve amblem için bir renk ve alfa değeri seçin
- **Emoji karıştırma** — açın ve nadirliği 1/N olarak ayarlayın (1 = tamamen emoji, 1000000 = milyonda bir)

### Çıkış Animasyonları
Açılış ekranı kapandığında amblem 9 animasyon modundan biriyle çıkar.
Her modun, açılır menüden seçtiğinizde devreye giren kendi kontrol kaydırıcıları vardır.

- **Dışa spiral** — harfler merkezden dışa doğru spiral çizer
- **İçe spiral** — harfler yapılandırılabilir yarıçap ve uzunlukla daralan bir spirale doğru birleşir
- **Patlama** — harfler yerçekimiyle dışa doğru saçılır
- **Patlama 2** — kenarlardan sekme ile fizik tabanlı patlama, yapılandırılabilir kuvvet, kaos ve eksen başına momentum
- **Uzaklaşma** — harfler yönlendirmeye dayalı eğimle yukarı doğru sürüklenir
- **Yatay düzleştirme** — harfler yatay olarak yayılır ve yapılandırılabilir bekleme süresiyle 1px çizgiye sıkışır
- **Hafif patlama** — daha az kuvvetle daha yumuşak bir patlama
- **Starwars kaydırması** — harfler yapılandırılabilir hedef Y konumuyla bir kaybolma noktasına doğru birleşir
- **Patlama 3** — amblem eksen başına momentum kontrolüyle bireysel piksellere ayrılır
- **Yağmur itmesi** — harfler ayrılır ve yağmur onları fiziksel olarak ekran dışına iter
- **Rastgele** — her seferinde farklı bir mod seçer

### Animasyon Ayarları Paneli
Sohbet başlığındaki dişli simgesinden animasyon ayarlarını açın. Sohbet, Bobber ve Açılış Ekranı olmak üzere üç sekmesi vardır.
Açılış Ekranı sekmesi, iki daraltılabilir akordeon (Görünüm ve Hareket), mod başına kaydırıcılı çıkış modu açılır menüsü ve animasyonları test etmek için tıklayabileceğiniz canlı önizleme tuvali içerir.
Panel tamamen sürükleyebilir ve yeniden boyutlandırılabilir olup yükseklik sınırı yoktur.

## Kurulum

### Kaynaktan
```bash
npm install
./compile-and-install.sh
# Ardından: Ctrl+Shift+P → Developer: Reload Window
```

### Gereksinimler
- VS Code 1.120.0 veya üzeri
- Çalışan bir yerel agent çalışma zamanı (ör. OpenClaw Gateway, Hermes panosu, Souveraine sunucusu)

---

> Burada belgelenmeyen sürpriz yumurtalar var. Nokta bu.

## Katkılar

Owen-Liuyuxuan'ın [openclaw_vscode](https://github.com/Owen-Liuyuxuan/openclaw_vscode) projesi temel alınmıştır (MIT).
WebSocket/gateway altyapısı bu projeye dayanır.
Çoklu köprü mimarisi, modüler webview arayüzü, animasyon motoru ve model/oturum yöneticileri Junction'a özgüdür.

---

MIT Lisansı. © Owen-Liuyuxuan (orijinal openclaw_vscode), © Plaer1 (Junction).
[github.com/Plaer1/junction](https://github.com/Plaer1/junction)
