fun_call({

  stuff <-
    namespace:::fun_call() %>%
    fun_call()

  stuff
})

fun_call({
  stuff <-
    namespace::fun_call() %>%
    fun_call()
  stuff
})
