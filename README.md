# MyTube — قنواتي على يوتيوب

تطبيق ويب عربي (PWA) بواجهة فيديو شبيهة بيوتيوب، لكنه **لا يعرض إلا الفيديوهات الجديدة من القنوات المشترك فيها بحسابك على يوتيوب**. فيه ربط حساب Google (OAuth)، بحث داخل قنواتك، محفوظات، سجل مشاهدات، ومساعد **Gemini** يلخص ويرشح لك.

- واجهة عربية RTL، وضع داكن، تعمل على الهاتف والكمبيوتر.
- لا سيرفر ولا قاعدة بيانات: المفاتيح والبيانات محفوظة في متصفحك فقط.
- قابل للتثبيت كتطبيق (PWA) ويعمل دون اتصال لهيكل الواجهة.

## الرابط المنشور

https://khalooda2562008-dotcom.github.io/mytube/

## طريقة التشغيل (خطوات المفاتيح)

التطبيق يحتاج مفاتيحك من حسابك في Google لأن اشتراكاتك بيانات خاصة:

1. **مشروع في Google Cloud** — افتح <https://console.cloud.google.com> وأنشئ مشروعاً.
2. **تفعيل YouTube Data API v3** — من *APIs & Services → Library* ابحث عن `YouTube Data API v3` واضغط Enable.
3. **API key** — من *APIs & Services → Credentials → Create credentials → API key*، انسخه.
4. **OAuth client** — نفس الصفحة → *Create credentials → OAuth client ID* → نوع **Web application**.
   - في **Authorized JavaScript origins** أضف:
     `https://khalooda2562008-dotcom.github.io`
   - (للتجربة المحلية أضف أيضاً `http://localhost:8000`)
   - لو طلب منك «شاشة الموافقة» (OAuth consent screen) اختر External ثم أضف بريدك في Test users.
5. **Gemini key** — افتح <https://aistudio.google.com/apikey> وأنشئ مفتاحاً.
6. افتح التطبيق → ⚙️ الإعدادات → الصق المفاتيح الثلاثة → حفظ → **ربط حساب Google** ووافق على قراءة قنواتك.

بعد الموافقة يظهر آخر 50 فيديو من قنواتك، مع عدد الفيديوهات ووقت النشر ومدة كل فيديو.

## كيف يعمل

| الجزء | التقنية |
| --- | --- |
| الاشتراكات | `subscriptions.list?mine=true` بصلاحية `youtube.readonly` |
| الفيديوهات | `activities.list?mine=true` — يعيد فقط نشاط القنوات المشترك فيها |
| تفاصيل الفيديو | `videos.list` للمدة والمشاهدات |
| البحث | `search.list` ثم تصفية النتائج على قنواتك |
| المشغل | YouTube IFrame (نطاق `youtube-nocookie.com`) |
| الذكاء | Gemini API (`gemini-2.5-flash` مع بديل `gemini-2.0-flash`) |
| التخزين | LocalStorage: المفاتيح، المحفوظات، المشاهدات |

## الخصوصية والحصص

- المفاتيح تُحفظ في `localStorage` على جهازك ولا تُرسل إلا إلى Google.
- حصة YouTube API الافتراضية 10,000 وحدة يومياً — تحديث الصفحة يستهلك وحدات قليلة، والبحث أكثر.
- تسجيل الدخول ينتهي بعد ساعة تقريباً؛ اضغط «ربط حساب Google» من جديد.

## التطوير محلياً

```bash
python3 -m http.server 8000
# ثم افتح http://localhost:8000
```

لا توجد حزم ولا خطوة بناء — HTML/CSS/JS فقط.

## الترخيص

MIT — راجع ملف `LICENSE`.
