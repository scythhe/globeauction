// Georgian-first: ka is the default and the language every key below is
// written for first — en/ru are translations of it, not the other way
// around. Machine-drafted for all three; get a native speaker to pass over
// ka/ru before this goes in front of real bidders, especially the
// auction-mechanics copy (Max Bid, reserve, outbid) where a slightly wrong
// word could genuinely confuse someone about their own bid.
export type Lang = "ka" | "en" | "ru";

export const LANGUAGES: { code: Lang; label: string }[] = [
  { code: "ka", label: "KA" },
  { code: "en", label: "EN" },
  { code: "ru", label: "RU" },
];

export const DEFAULT_LANG: Lang = "ka";

type Entry = Record<Lang, string>;

export const dict: Record<string, Entry> = {
  // --- common ---
  "common.loading": { ka: "იტვირთება…", en: "Loading…", ru: "Загрузка…" },
  "common.uploading": { ka: "იტვირთება…", en: "Uploading…", ru: "Загрузка…" },

  // --- nav / shell ---
  "nav.teamPanel": { ka: "გუნდის პანელი", en: "Team panel", ru: "Панель команды" },
  "nav.logOut": { ka: "გასვლა", en: "Log out", ru: "Выйти" },
  "nav.logIn": { ka: "შესვლა", en: "Log in", ru: "Войти" },
  "nav.register": { ka: "რეგისტრაცია", en: "Register", ru: "Регистрация" },

  // --- hero / list ---
  "hero.titleLine1": { ka: "ერთი მანქანა. ერთი კვირა.", en: "ONE CAR. ONE WEEK.", ru: "ОДНА МАШИНА. ОДНА НЕДЕЛЯ." },
  "hero.titleLine2": { ka: "ერთი აუქციონი.", en: "ONE AUCTION.", ru: "ОДИН АУКЦИОН." },
  "hero.subtitle": {
    ka: "კომპანიის საკუთარი ავტოპარკი, პარალელური ბიდინგით, ცოცხალი განახლებებით და დაუყოვნებელი ყიდვის ოფციით.",
    en: "Company-owned inventory, sold to the highest bidder — proxy bidding, live updates, Buy It Now.",
    ru: "Собственный автопарк компании — прокси-ставки, обновления в реальном времени, мгновенная покупка.",
  },
  "hero.liveNow": { ka: "ამჟამად აქტიური", en: "Live now", ru: "Сейчас идёт" },
  "hero.sold": { ka: "გაყიდული", en: "Sold", ru: "Продано" },
  "hero.totalSoldVolume": { ka: "გაყიდვების ჯამური მოცულობა", en: "Total sold volume", ru: "Общий объём продаж" },
  "list.noAuctions": { ka: "აუქციონები ჯერ არ არის.", en: "No auctions yet.", ru: "Аукционов пока нет." },
  "list.noPhotoYet": { ka: "ფოტო ჯერ არ არის", en: "No photo yet", ru: "Фото пока нет" },
  "list.buyNowBadge": { ka: "დაუყოვნებელი ყიდვა", en: "Buy Now", ru: "Купить сейчас" },
  "list.vehicleFallback": { ka: "ავტომობილი", en: "Vehicle", ru: "Автомобиль" },
  "list.currentBid": { ka: "მიმდინარე ფასი", en: "Current bid", ru: "Текущая ставка" },

  // --- auction detail ---
  "detail.back": { ka: "← უკან აუქციონებზე", en: "← back to auctions", ru: "← назад к аукционам" },
  "detail.noPhotosYet": { ka: "ფოტოები ჯერ არ არის", en: "No photos yet", ru: "Фотографий пока нет" },
  "detail.currentBid": { ka: "მიმდინარე ფასი", en: "Current bid", ru: "Текущая ставка" },
  "detail.winning": { ka: "თქვენ ლიდერობთ", en: "You're winning", ru: "Вы лидируете" },
  "detail.outbid": { ka: "თქვენი ბიდი გადაჭარბებულია", en: "Outbid", ru: "Вас перебили" },
  "detail.reserveMet": { ka: "მინიმალური ფასი მიღწეულია", en: "Reserve met", ru: "Резерв достигнут" },
  "detail.reserveNotMet": { ka: "მინიმალური ფასი ჯერ არ არის მიღწეული", en: "Reserve not yet met", ru: "Резерв ещё не достигнут" },
  "detail.reserveTeamView": { ka: "მინიმალური ფასი: {price} (მხოლოდ გუნდისთვის)", en: "Reserve: {price} (team view)", ru: "Резерв: {price} (только для команды)" },
  "detail.soldFor": { ka: "გაიყიდა", en: "Sold for", ru: "Продано за" },
  "detail.buyNowButton": { ka: "დაუყოვნებელი ყიდვა — {price}", en: "Buy Now — {price}", ru: "Купить сейчас — {price}" },
  "detail.buyNowConfirm": {
    ka: "იყიდით ახლავე {price}-ად? ეს დაუყოვნებლივ დაასრულებს აუქციონს.",
    en: "Buy this now for {price}? This ends the auction immediately.",
    ru: "Купить сейчас за {price}? Это немедленно завершит аукцион.",
  },
  "detail.maxBidLabel": { ka: "მაქსიმალური ბიდი", en: "Max Bid", ru: "Максимальная ставка" },
  "detail.maxBidExplainer": {
    ka: "შეიყვანეთ მაქსიმალური თანხა, რომლის გადახდაც შეგიძლიათ. სისტემა ავტომატურად დადებს ბიდს თქვენს ნაცვლად, მხოლოდ იმდენად, რამდენადაც საჭიროა ლიდერობის შესანარჩუნებლად — არასდროს ამ რიცხვზე მეტს.",
    en: "Enter the most you're willing to pay. We bid on your behalf automatically, raising only as far as needed to keep you in the lead — never past this number.",
    ru: "Укажите максимальную сумму, которую готовы заплатить. Мы будем делать ставки за вас автоматически, повышая ровно настолько, насколько нужно, чтобы удержать лидерство — никогда не больше этой суммы.",
  },
  "detail.placeMaxBid": { ka: "სწრაფი ბიდი", en: "Quick Bid", ru: "Быстрая ставка" },
  "detail.monsterBidToggle": { ka: "მონსტრ-ბიდი", en: "Monster Bid", ru: "Монстр-ставка" },
  "detail.monsterBidExplainer": {
    ka: "შეიყვანეთ ზუსტი თანხა და დაუყოვნებლივ გადადით მასზე — საფეხურების გვერდის ავლით. ეს დიდი, გადაწყვეტილი ნაბიჯია.",
    en: "Enter an exact amount and jump straight to it — bypassing the increment steps. A big, deliberate move.",
    ru: "Введите точную сумму и сразу перейдите к ней — в обход шагов увеличения. Крупный, обдуманный шаг.",
  },
  "detail.monsterBidPlaceholder": { ka: "შეიყვანეთ თანხა", en: "Enter amount", ru: "Введите сумму" },
  "detail.monsterBidConfirm": {
    ka: "მონსტრ-ბიდი {amount}-ზე? ეს დაუყოვნებლივ დააყენებს ფასს ამ დონეზე.",
    en: "Monster Bid of {amount}? This immediately sets the price to that level.",
    ru: "Монстр-ставка {amount}? Это сразу установит цену на этом уровне.",
  },
  "detail.monsterBidSubmit": { ka: "დადასტურება", en: "Confirm", ru: "Подтвердить" },
  "detail.enterValidAmount": { ka: "შეიყვანეთ სწორი თანხა", en: "Enter a valid amount", ru: "Введите корректную сумму" },
  "detail.won": { ka: "თქვენ მოიგეთ!", en: "You won!", ru: "Вы выиграли!" },
  "detail.stepDown": { ka: "თანხის შემცირება", en: "Decrease amount", ru: "Уменьшить сумму" },
  "detail.stepUp": { ka: "თანხის გაზრდა", en: "Increase amount", ru: "Увеличить сумму" },
  "detail.tooLowMinimum": { ka: "თანხა ძალიან დაბალია — მინიმუმია {amount} ₾", en: "Too low — minimum is {amount} ₾", ru: "Слишком низкая ставка — минимум {amount} ₾" },
  "detail.biddingNotEnabled": {
    ka: "ბიდინგი თქვენს ანგარიშზე ჯერ არ არის ჩართული — დაუკავშირდით გუნდს.",
    en: "Bidding isn't enabled on your account yet — contact the team.",
    ru: "Ставки на вашем аккаунте ещё не включены — свяжитесь с командой.",
  },
  "detail.teamCannotBid": { ka: "გუნდის ანგარიშებს ბიდის დადება არ შეუძლიათ.", en: "Team accounts can't bid.", ru: "Аккаунты команды не могут делать ставки." },
  "detail.logInToBid": { ka: "ბიდის დასადებად შედით სისტემაში.", en: "Log in to bid.", ru: "Войдите, чтобы делать ставки." },

  // --- vehicle spec labels ---
  "spec.bodyStyle": { ka: "ძარის ტიპი", en: "Body style", ru: "Тип кузова" },
  "spec.color": { ka: "ფერი", en: "Color", ru: "Цвет" },
  "spec.mileage": { ka: "გარბენი", en: "Mileage", ru: "Пробег" },
  "spec.mileageUnconfirmed": { ka: " (დაუდასტურებელი)", en: " (unconfirmed)", ru: " (не подтверждено)" },
  "spec.engine": { ka: "ძრავი", en: "Engine", ru: "Двигатель" },
  "spec.fuel": { ka: "საწვავი", en: "Fuel", ru: "Топливо" },
  "spec.transmission": { ka: "გადაცემათა კოლოფი", en: "Transmission", ru: "Коробка передач" },
  "spec.driveType": { ka: "წამყვანი თვლები", en: "Drive type", ru: "Привод" },
  "spec.doors": { ka: "კარები", en: "Doors", ru: "Двери" },
  "spec.steering": { ka: "საჭე", en: "Steering", ru: "Руль" },
  "spec.interior": { ka: "სალონი", en: "Interior", ru: "Салон" },
  "spec.vin": { ka: "VIN კოდი", en: "VIN", ru: "VIN" },
  "spec.location": { ka: "მდებარეობა", en: "Location", ru: "Расположение" },
  "spec.customs": { ka: "განბაჟება", en: "Customs", ru: "Растаможка" },
  "spec.customsCleared": { ka: "განბაჟებული", en: "Cleared", ru: "Растаможено" },
  "spec.customsNotCleared": { ka: "განუბაჟებელი", en: "Not cleared", ru: "Не растаможено" },
  "spec.techInspection": { ka: "ტექდათვალიერება", en: "Tech inspection", ru: "Техосмотр" },
  "spec.techPassed": { ka: "გავლილი", en: "Passed", ru: "Пройден" },
  "spec.techNotPassed": { ka: "გაუვლელი", en: "Not passed", ru: "Не пройден" },
  "spec.damage": { ka: "დაზიანება", en: "Damage", ru: "Повреждение" },
  "spec.runsAndDrives": { ka: "იმუშავებს/დადის", en: "Runs/drives", ru: "На ходу" },
  "spec.title": { ka: "საკუთრების დოკუმენტი", en: "Title", ru: "Документ о праве собственности" },
  "spec.keys": { ka: "გასაღები", en: "Keys", ru: "Ключи" },
  "spec.keysPresent": { ka: "არის", en: "Present", ru: "Есть" },
  "spec.keysMissing": { ka: "აკლია", en: "Missing", ru: "Отсутствуют" },

  // --- status badges ---
  "status.live": { ka: "აქტიური", en: "Live", ru: "Активен" },
  "status.scheduled": { ka: "დაგეგმილი", en: "Scheduled", ru: "Запланирован" },
  "status.sold": { ka: "გაყიდული", en: "Sold", ru: "Продан" },
  "status.unsold": { ka: "გაუყიდავი", en: "Unsold", ru: "Не продан" },
  "status.cancelled": { ka: "გაუქმებული", en: "Cancelled", ru: "Отменён" },
  "status.pending_seller": { ka: "გამყიდველის გადაწყვეტილება", en: "Pending seller", ru: "Ожидает продавца" },
  "status.counter_offered": { ka: "საპასუხო შეთავაზება", en: "Counter offered", ru: "Встречное предложение" },

  // --- countdown ---
  "countdown.ended": { ka: "დასრულდა", en: "Ended", ru: "Завершён" },
  "countdown.extended": { ka: "გახანგრძლივდა", en: "Extended", ru: "Продлён" },
  "countdown.bonusTime": { ka: "ბონუს დრო!", en: "Bonus time!", ru: "Бонусное время!" },

  // --- login ---
  "login.title": { ka: "შესვლა", en: "Log in", ru: "Вход" },
  "login.email": { ka: "ელფოსტა", en: "Email", ru: "Эл. почта" },
  "login.password": { ka: "პაროლი", en: "Password", ru: "Пароль" },
  "login.submit": { ka: "შესვლა", en: "Log in", ru: "Войти" },
  "login.noAccount": { ka: "არ გაქვთ ანგარიში?", en: "No account?", ru: "Нет аккаунта?" },
  "login.registerLink": { ka: "რეგისტრაცია", en: "Register", ru: "Регистрация" },

  // --- register ---
  "register.title": { ka: "რეგისტრაცია", en: "Register", ru: "Регистрация" },
  "register.explainer": {
    ka: "ბიდინგისთვის საჭიროა 500 ₾ დეპოზიტი და გუნდის დადასტურება — რეგისტრაციის შემდეგ დაუკავშირდით გუნდს.",
    en: "Bidding needs a 500 ₾ deposit and team approval after this — see the team once you've registered.",
    ru: "Для ставок нужен депозит 500 ₾ и подтверждение от команды — обратитесь к команде после регистрации.",
  },
  "register.fullName": { ka: "სრული სახელი", en: "Full name", ru: "Полное имя" },
  "register.email": { ka: "ელფოსტა", en: "Email", ru: "Эл. почта" },
  "register.password": { ka: "პაროლი", en: "Password", ru: "Пароль" },
  "register.submit": { ka: "რეგისტრაცია", en: "Register", ru: "Зарегистрироваться" },
  "register.alreadyRegistered": { ka: "უკვე რეგისტრირებული ხართ?", en: "Already registered?", ru: "Уже зарегистрированы?" },
  "register.loginLink": { ka: "შესვლა", en: "Log in", ru: "Войти" },

  // --- team panel ---
  "team.title": { ka: "გუნდის პანელი", en: "Team panel", ru: "Панель команды" },
  "team.step1Title": { ka: "1. ამ კვირის ავტომობილის დამატება", en: "1. Create this week's vehicle", ru: "1. Добавить автомобиль этой недели" },
  "team.make": { ka: "მარკა", en: "Make", ru: "Марка" },
  "team.model": { ka: "მოდელი", en: "Model", ru: "Модель" },
  "team.year": { ka: "წელი", en: "Year", ru: "Год" },
  "team.createVehicle": { ka: "ავტომობილის დამატება", en: "Create vehicle", ru: "Добавить автомобиль" },
  "team.vehicleIdLabel": { ka: "ავტომობილის ID", en: "Vehicle ID", ru: "ID автомобиля" },
  "team.step1bTitle": { ka: "1ბ. ფოტოები", en: "1b. Photos", ru: "1б. Фотографии" },
  "team.addPhoto": { ka: "+ ფოტოს დამატება (jpeg/png/webp, მაქს. 10MB)", en: "+ Add photo (jpeg/png/webp, max 10MB)", ru: "+ Добавить фото (jpeg/png/webp, макс. 10МБ)" },
  "team.step2Title": { ka: "2. აუქციონის შექმნა", en: "2. Create the auction", ru: "2. Создать аукцион" },
  "team.vehicleIdPlaceholder": { ka: "პირველი ნაბიჯიდან, ან ჩასვით ID", en: "from step 1, or paste one", ru: "из шага 1, или вставьте ID" },
  "team.startingPrice": { ka: "საწყისი ფასი (₾)", en: "Starting price (₾)", ru: "Начальная цена (₾)" },
  "team.reservePrice": { ka: "მინიმალური ფასი (₾) — უნდა იყოს ≥ საწყისი ფასი", en: "Reserve price (₾) — must be ≥ starting price", ru: "Резервная цена (₾) — должна быть ≥ начальной" },
  "team.buyNowPrice": { ka: "დაუყოვნებელი ყიდვის ფასი (₾) — არასავალდებულო, უნდა იყოს ≥ მინიმალური ფასი", en: "Buy It Now price (₾) — optional, must be ≥ reserve", ru: "Цена мгновенной покупки (₾) — необязательно, должна быть ≥ резервной" },
  "team.leaveBlankToDisable": { ka: "დატოვეთ ცარიელი გამოსართავად", en: "leave blank to disable", ru: "оставьте пустым, чтобы отключить" },
  "team.gelRateLabel": { ka: "ლარი 1 დოლარში — არასავალდებულო, აჩვენებს \"≈ $\" ხაზს ყველა ფასთან", en: "GEL per 1 USD — optional, shows a \"≈ $\" line on every price if set", ru: "Лари за 1 доллар — необязательно, показывает строку «≈ $» рядом с каждой ценой" },
  "team.gelRatePlaceholder": { ka: "მაგ. 2.7000 — დატოვეთ ცარიელი დოლარის ხაზის დასამალად", en: "e.g. 2.7000 — leave blank to hide the USD line", ru: "напр. 2.7000 — оставьте пустым, чтобы скрыть строку в долларах" },
  "team.startsAt": { ka: "დაწყების დრო", en: "Starts at", ru: "Начало" },
  "team.endsAt": { ka: "დასრულების დრო", en: "Ends at", ru: "Окончание" },
  "team.createAuction": { ka: "აუქციონის შექმნა", en: "Create auction", ru: "Создать аукцион" },
  "team.auctionCreated": { ka: "აუქციონი შეიქმნა: {id}", en: "Created auction {id}", ru: "Аукцион создан: {id}" },
  "team.buyersAwaitingVetting": { ka: "შემოწმების მოლოდინში მყოფი მყიდველები", en: "Buyers awaiting vetting", ru: "Покупатели, ожидающие проверки" },
  "team.nobodyWaiting": { ka: "არავინ ელოდება.", en: "Nobody waiting.", ru: "Никто не ожидает." },
  "team.colName": { ka: "სახელი", en: "Name", ru: "Имя" },
  "team.colEmail": { ka: "ელფოსტა", en: "Email", ru: "Эл. почта" },
  "team.colDeposit": { ka: "დეპოზიტი", en: "Deposit", ru: "Депозит" },
  "team.depositReceived": { ka: "{amount} მიღებულია", en: "{amount} received", ru: "{amount} получено" },
  "team.depositNone": { ka: "არცერთი", en: "none", ru: "нет" },
  "team.recordDeposit": { ka: "500 ₾ დეპოზიტის დაფიქსირება", en: "Record 500 ₾ deposit", ru: "Зафиксировать депозит 500 ₾" },
  "team.enableBidding": { ka: "ბიდინგის ჩართვა", en: "Enable bidding", ru: "Включить ставки" },

  // --- errors (mapped from backend error codes) ---
  "error.generic": { ka: "დაფიქსირდა შეცდომა", en: "Something went wrong", ru: "Произошла ошибка" },
  "error.rateLimited": { ka: "მცდელობები ძალიან ბევრია — დაელოდეთ {seconds} წამს და სცადეთ ისევ.", en: "Too many attempts — wait {seconds}s and try again.", ru: "Слишком много попыток — подождите {seconds} с. и попробуйте снова." },
  "error.invalid_credentials": { ka: "ელფოსტა ან პაროლი არასწორია", en: "Incorrect email or password", ru: "Неверный email или пароль" },
  "error.email_taken": { ka: "ეს ელფოსტა უკვე რეგისტრირებულია", en: "This email is already registered", ru: "Этот email уже зарегистрирован" },
  "error.validation_error": { ka: "შეამოწმეთ შეყვანილი მონაცემები", en: "Please check the entered details", ru: "Проверьте введённые данные" },
  "error.unauthenticated": { ka: "საჭიროა სისტემაში შესვლა", en: "You need to log in", ru: "Необходимо войти в систему" },
  "error.forbidden": { ka: "თქვენ არ გაქვთ ამის უფლება", en: "You don't have permission to do that", ru: "У вас нет прав для этого действия" },
  "error.not_found": { ka: "ვერ მოიძებნა", en: "Not found", ru: "Не найдено" },
  "error.auction_not_live": { ka: "აუქციონი ამჟამად აქტიური არ არის", en: "This auction isn't live right now", ru: "Этот аукцион сейчас неактивен" },
  "error.account_inactive": { ka: "თქვენი ანგარიში გაუქმებულია", en: "Your account is inactive", ru: "Ваш аккаунт неактивен" },
  "error.bidding_disabled": { ka: "ბიდინგი თქვენს ანგარიშზე ჩართული არ არის", en: "Bidding isn't enabled on your account", ru: "Ставки на вашем аккаунте не включены" },
  "error.own_organization": { ka: "საკუთარი ორგანიზაციის ავტომობილზე ბიდის დადება არ შეიძლება", en: "You can't bid on your own organization's vehicle", ru: "Нельзя делать ставки на автомобиль своей организации" },
  "error.bid_limit_exceeded": { ka: "თანხა აჭარბებს თქვენს ბიდის ლიმიტს", en: "That amount is above your bid limit", ru: "Сумма превышает лимит ваших ставок" },
  "error.buy_now_not_available": { ka: "დაუყოვნებელი ყიდვა ხელმისაწვდომი არ არის", en: "Buy It Now isn't available on this auction", ru: "Мгновенная покупка недоступна для этого аукциона" },
  "error.buy_now_already_bid": { ka: "დაუყოვნებელი ყიდვა ხელმისაწვდომი აღარ არის — ბიდი უკვე დადებულია", en: "Buy It Now is no longer available — a bid already exists", ru: "Мгновенная покупка больше недоступна — ставка уже сделана" },
  "error.buy_now_below_reserve": { ka: "დაუყოვნებელი ყიდვის ფასი მინიმალურ ფასზე დაბალია", en: "Buy It Now price is below the reserve", ru: "Цена мгновенной покупки ниже резервной" },
  "error.cannot_cancel": { ka: "ეს აუქციონი ვერ გაუქმდება", en: "This auction can't be cancelled", ru: "Этот аукцион нельзя отменить" },
  "error.cannot_reassign": { ka: "გაყიდვის გადანაწილება ვერ ხერხდება", en: "This sale can't be reassigned", ru: "Эту продажу нельзя переназначить" },
  "error.deposit_below_minimum": { ka: "დეპოზიტი მინიმალურ ოდენობაზე ნაკლებია", en: "Deposit is below the minimum", ru: "Депозит меньше минимального" },
  "error.deposit_required": { ka: "საჭიროა დეპოზიტის შეტანა", en: "A deposit is required first", ru: "Сначала необходим депозит" },
  "error.file_too_large": { ka: "ფაილი ძალიან დიდია", en: "File is too large", ru: "Файл слишком большой" },
  "error.invalid_auction_window": { ka: "აუქციონის დაწყება/დასრულების დრო არასწორია", en: "Auction start/end time is invalid", ru: "Неверное время начала/окончания аукциона" },
  "error.invalid_price": { ka: "ფასი არასწორია", en: "Price is invalid", ru: "Неверная цена" },
  "error.not_pending_seller": { ka: "აუქციონი გამყიდველის გადაწყვეტილების მოლოდინში არ არის", en: "This auction isn't waiting on a seller decision", ru: "Этот аукцион не ожидает решения продавца" },
  "error.reserve_below_starting_price": { ka: "მინიმალური ფასი საწყის ფასზე დაბალია", en: "Reserve price is below the starting price", ru: "Резервная цена ниже начальной" },
  "error.unsupported_content_type": { ka: "ფაილის ტიპი მხარდაჭერილი არ არის", en: "Unsupported file type", ru: "Неподдерживаемый тип файла" },
  "error.upload_not_found": { ka: "ატვირთვა ვერ მოიძებნა", en: "Upload not found", ru: "Загрузка не найдена" },
  "error.vehicle_not_approved": { ka: "ავტომობილი ჯერ არ არის დამტკიცებული", en: "Vehicle isn't approved yet", ru: "Автомобиль ещё не одобрен" },
};
