# kotlinx.serialization
-keepattributes *Annotation*, InnerClasses
-dontnote kotlinx.serialization.**
-keepclassmembers class au.sam.seamless.** { *** Companion; }
-keepclasseswithmembers class au.sam.seamless.** { kotlinx.serialization.KSerializer serializer(...); }
-keep,includedescriptorclasses class au.sam.seamless.**$$serializer { *; }
# OkHttp
-dontwarn okhttp3.internal.platform.**
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**
-dontwarn javax.annotation.**
