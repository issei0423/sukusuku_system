package main

/*
連絡帳と「ねた・おきた」の文言（詳細設計書「全章に共通する実装の決まり」(1-5) の決めたこと D-1）。

基本設計書「メッセージ一覧」(4-12) の「文言はマスタとして持ち、コードに直接書かない」を、
サーバはこのファイル、画面とモックは web/src/messages.ts の定数に1か所ずつ集めることで満たす。
文言は詳細設計書「本書で足す文言」(4-1 (6)) と各経路の表から写した。片方を直したらもう片方も直す。
*/
const (
	// 参照できない園児・記録（存在しない場合と同じ文言。詳細設計書「判定の関数」(4-1 (2))）
	msgContactForbidden = "この園児の連絡帳は開けません。"
	// 【仮置き】クラスの連絡帳を開けないとき。設計に文言が無い（web/仮置き値.md）
	msgContactClassForbidden = "このクラスの連絡帳は開けません。"
	// 猶予中の保護者が家庭からを送ろうとした（詳細設計書「家庭から」(4-3 (5))）
	msgContactGraceReadOnly = "卒園・退園したお子さまの連絡帳は、読むことだけができます。"
	msgGuardianOnly         = "保護者のみが行えます"
	msgContactBadDate       = "日付の形式が正しくありません。"
	msgContactLoadFailed    = "連絡帳を読み込めませんでした。もう一度お試しください。"
	msgContactSaveFailed    = "保存できませんでした。もう一度お試しください。"

	// 家庭から（詳細設計書「家庭から」(4-3 (5))・「確認しました」(4-3 (6))）
	msgHomeEmpty           = "1つ以上の項目を入れてください。"
	msgTemperatureFormat   = "体温は数値で、小数第1位まで入力してください。"
	msgBadChoice           = "選べない値が入っています。画面を読み込み直してください。"
	msgPickupRequired      = "お迎えの人と時刻を入れてください。"
	msgPickupPersonTooLong = "お迎えの人は50文字以内で入力してください。"
	msgHomeMessageTooLong  = "連絡事項は500文字以内で入力してください。"
	msgHomeConflict        = "ほかのご家族が家庭からを直しました。読み直してから直してください。"
	msgConfirmConflict     = "家庭からの連絡が更新されました。読み直してから確認してください。"

	// ねた・おきた（詳細設計書「午睡の園児」(3-4)・「午睡（ねた・おきた・対象外）」(4-6)）
	msgNapNotStarted = "午睡チェックが始まっていません。開始してから押してください。"
	msgSessionEnded  = "午睡チェックは終了しています。画面を読み込み直してください。"
	msgSleepTwice    = "すでに「ねた」が記録されています。画面を読み込み直してください。"
	msgSleepExcluded = "この園児は対象外になっています。戻してから押してください。"
	// 【仮置き】おきた済みの「おきた」。設計は 409 already_exists とするが文言が無い（web/仮置き値.md）
	msgWokeTwice = "すでに「おきた」が記録されています。画面を読み込み直してください。"
	// きょうは対象外（詳細設計書「行の状態ごとの表示」(2-4 (2))）
	msgExcludeAfterSleep = "『ねた』を記録した園児は対象外にできません。"
	// 【仮置き】対象外が既にあるとき。設計は 409 already_exists とするが文言が無い（web/仮置き値.md）
	msgExcludedTwice = "すでに対象外になっています。画面を読み込み直してください。"
)

// 成長の記録（詳細設計書「成長の記録」(4-12 (1))・「本書で足す文言」(4-1 (6))）
const (
	// 参照できない成長の記録（存在しない園児と同じ文言）
	msgGrowthForbidden = "この園児の成長の記録は開けません。"
	// 【仮置き】成長の記録を読めなかったとき。設計に文言が無い（web/仮置き値.md）
	msgGrowthLoadFailed = "成長の記録を読み込めませんでした。もう一度お試しください。"
)

// 誤りの応答の kind（詳細設計書「誤りの応答」(4-1 (3))）
const (
	kindVersionConflict = "version_conflict"
	kindAlreadyExists   = "already_exists"
	kindSessionEnded    = "session_ended"
)
