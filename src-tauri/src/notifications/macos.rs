//! Local `UserNotifications`, including macOS's real one-time authorization dialog.

use std::ptr::NonNull;
use std::sync::{mpsc, LazyLock};

use block2::{DynBlock, RcBlock};
use objc2::rc::Retained;
use objc2::runtime::{Bool, ProtocolObject};
use objc2::{define_class, msg_send, ClassType};
use objc2_foundation::{ns_string, NSBundle, NSError, NSObject, NSObjectProtocol, NSString};
use objc2_user_notifications::{
    UNAuthorizationOptions, UNAuthorizationStatus, UNMutableNotificationContent, UNNotification,
    UNNotificationPresentationOptions, UNNotificationRequest, UNNotificationSettings,
    UNUserNotificationCenter, UNUserNotificationCenterDelegate,
};

use super::Permission;

define_class!(
    #[unsafe(super(NSObject))]
    struct PresentationDelegate;

    // SAFETY: The class has NSObject's layout and implements no additional requirements.
    unsafe impl NSObjectProtocol for PresentationDelegate {}

    // SAFETY: The selector and callback signature match UserNotifications' protocol.
    unsafe impl UNUserNotificationCenterDelegate for PresentationDelegate {
        #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
        fn present(
            &self,
            _center: &UNUserNotificationCenter,
            _notification: &UNNotification,
            completion: &DynBlock<dyn Fn(UNNotificationPresentationOptions)>,
        ) {
            // The dispatcher already suppressed the conversation being viewed;
            // another tab's alert should still appear while the app is focused.
            completion
                .call((UNNotificationPresentationOptions::Banner
                    | UNNotificationPresentationOptions::List,));
        }
    }
);

thread_local! {
    // UNUserNotificationCenter's delegate is weak; the main thread owns it for
    // the app's lifetime, without sending Objective-C objects between threads.
    static DELEGATE: Retained<PresentationDelegate> = {
        // SAFETY: This NSObject subclass has no ivars or custom initializer.
        unsafe { msg_send![PresentationDelegate::class(), new] }
    };
}

fn available() -> bool {
    static BUNDLED: LazyLock<bool> = LazyLock::new(|| {
        let bundle = NSBundle::mainBundle();
        bundle.bundleIdentifier().is_some() && bundle.bundlePath().hasSuffix(ns_string!(".app"))
    });
    *BUNDLED
}

pub fn install() {
    // The native API raises an Objective-C exception without an app bundle
    // (e.g. `tauri dev`); never initialize it in an unbundled process.
    if !available() {
        return;
    }
    DELEGATE.with(|delegate| {
        UNUserNotificationCenter::currentNotificationCenter()
            .setDelegate(Some(ProtocolObject::from_ref(&**delegate)));
    });
}

const fn permission_for(status: UNAuthorizationStatus) -> Permission {
    match status {
        UNAuthorizationStatus::NotDetermined => Permission::Prompt,
        UNAuthorizationStatus::Authorized
        | UNAuthorizationStatus::Provisional
        | UNAuthorizationStatus::Ephemeral => Permission::Granted,
        _ => Permission::Denied,
    }
}

fn error_text(error: *mut NSError) -> Option<String> {
    // SAFETY: UserNotifications supplies either null or an NSError valid for
    // this completion callback. No reference escapes the callback.
    unsafe { error.as_ref() }.map(|error| error.localizedDescription().to_string())
}

pub async fn permission(request: bool) -> Result<Permission, String> {
    if !available() {
        return Err("Desktop notification permission requires launching the .app bundle, not an unbundled development executable.".into());
    }
    let (sender, receiver) = mpsc::channel();
    {
        let center = UNUserNotificationCenter::currentNotificationCenter();
        if request {
            let callback = RcBlock::new(move |granted: Bool, error: *mut NSError| {
                let result = error_text(error).map_or_else(
                    || {
                        Ok(if granted.as_bool() {
                            Permission::Granted
                        } else {
                            Permission::Denied
                        })
                    },
                    Err,
                );
                let _ = sender.send(result);
            });
            // This asks only when macOS has no decision yet; a denial cannot
            // be re-prompted. No APNs capability or signing certificate is used.
            center.requestAuthorizationWithOptions_completionHandler(
                UNAuthorizationOptions::Alert,
                &callback,
            );
        } else {
            let callback = RcBlock::new(move |settings: NonNull<UNNotificationSettings>| {
                // SAFETY: UserNotifications owns these non-null settings for
                // this callback; only the Copy authorization value leaves it.
                let status = unsafe { settings.as_ref() }.authorizationStatus();
                let _ = sender.send(Ok(permission_for(status)));
            });
            center.getNotificationSettingsWithCompletionHandler(&callback);
        }
    }
    crate::off_ipc(move || {
        receiver
            .recv()
            .map_err(|error| format!("notification authorization: {error}"))
    })
    .await??
}

pub fn show(sid: &str, title: &str, body: &str) {
    if !available() {
        return;
    }
    let content = UNMutableNotificationContent::new();
    content.setTitle(&NSString::from_str(title));
    content.setBody(&NSString::from_str(body));
    // One notification per conversation: a newer event replaces its older one.
    let request = UNNotificationRequest::requestWithIdentifier_content_trigger(
        &NSString::from_str(sid),
        &content,
        None,
    );
    let callback = RcBlock::new(|error: *mut NSError| {
        if let Some(error) = error_text(error) {
            eprintln!("[notifications] macOS rejected desktop notification: {error}");
        }
    });
    UNUserNotificationCenter::currentNotificationCenter()
        .addNotificationRequest_withCompletionHandler(&request, Some(&callback));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unbundled_permission_is_an_error_instead_of_a_native_exception() {
        assert!(!available());
        let result = tauri::async_runtime::block_on(permission(false));
        assert!(result.is_err());
    }

    #[test]
    fn undetermined_granted_and_denied_authorization_remain_distinct() {
        assert_eq!(
            permission_for(UNAuthorizationStatus::NotDetermined),
            Permission::Prompt
        );
        for status in [
            UNAuthorizationStatus::Authorized,
            UNAuthorizationStatus::Provisional,
            UNAuthorizationStatus::Ephemeral,
        ] {
            assert_eq!(permission_for(status), Permission::Granted);
        }
        assert_eq!(
            permission_for(UNAuthorizationStatus::Denied),
            Permission::Denied
        );
        assert_eq!(
            permission_for(UNAuthorizationStatus(99)),
            Permission::Denied
        );
    }
}
