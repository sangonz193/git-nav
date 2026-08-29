use proc_macro::TokenStream;
use quote::{format_ident, quote};
use syn::{parse_macro_input, FnArg, ItemFn, Pat, ReturnType, Type};

/// Derives an HTTP handler from a Tauri command.
///
/// The argument struct is built from the command's own parameter list, so the JSON the browser
/// sends and the JSON the webview sends are the same shape by construction. Renaming a parameter
/// moves both at once instead of leaving the two transports disagreeing.
///
/// Place it above `#[tauri::command]` so the signature is still intact when this runs.
#[proc_macro_attribute]
pub fn http_command(_attribute: TokenStream, item: TokenStream) -> TokenStream {
    let function = parse_macro_input!(item as ItemFn);
    let name = function.sig.ident.clone();
    let is_async = function.sig.asyncness.is_some();

    let mut fields = Vec::new();
    let mut arguments = Vec::new();
    for input in &function.sig.inputs {
        let FnArg::Typed(typed) = input else { continue };
        let Pat::Ident(pattern) = &*typed.pat else { continue };
        let field = &pattern.ident;
        let field_type = &typed.ty;
        fields.push(quote! { pub #field: #field_type });
        arguments.push(quote! { args.#field });
    }

    let args_type = format_ident!("__{}_args", name);
    let handler = format_ident!("__http_{}", name);

    // A command that cannot fail still has to reach `blocking`, which speaks in `Result`.
    let call = match (is_async, returns_result(&function.sig.output)) {
        (true, true) => quote! { #name(#(#arguments),*).await? },
        (true, false) => quote! { #name(#(#arguments),*).await },
        (false, true) => quote! { crate::server::blocking(move || #name(#(#arguments),*)).await? },
        (false, false) => {
            quote! { crate::server::blocking(move || Ok(#name(#(#arguments),*))).await? }
        }
    };

    quote! {
        #function

        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        #[allow(non_camel_case_types)]
        pub struct #args_type {
            #(#fields),*
        }

        pub(crate) async fn #handler(
            axum::Json(args): axum::Json<#args_type>,
        ) -> crate::server::CommandResult {
            crate::server::ok(#call)
        }
    }
    .into()
}

fn returns_result(output: &ReturnType) -> bool {
    let ReturnType::Type(_, kind) = output else {
        return false;
    };
    let Type::Path(path) = kind.as_ref() else {
        return false;
    };
    path.path
        .segments
        .last()
        .is_some_and(|segment| segment.ident == "Result")
}
